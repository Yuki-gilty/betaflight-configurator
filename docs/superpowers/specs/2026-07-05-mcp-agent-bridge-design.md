# 設計: Betaflight Configurator MCPエージェントブリッジ

日付: 2026-07-05
ステータス: 承認済み
スコープ: 個人用実験ツール(dev モード限定、プロダクションビルドには含めない)

## 目的

Web版 Betaflight Configurator(`npm run dev` で起動する Vite 開発サーバー)を、
MCP(Model Context Protocol)経由で外部の LLM エージェント(Claude Code / Claude Desktop 等)から
操作できるようにする。

- FC(フライトコントローラ)の設定値(PID・レート・フィルタ)を項目単位で読み書きできる
- Configurator の UI(タブ切替)を操作できる
- CLI コマンド文字列の注入は行わない。設定操作はすべて構造化された
  ツール引数 → FC オブジェクト → MSP プロトコル送信の経路で行う

## 全体構成

```
Claude Code / Claude Desktop
     │ MCP (stdio)
     ▼
[1] tools/mcp-bridge/          ← 新規 Node パッケージ(中継プロセス)
     │ WebSocket (ws://127.0.0.1:8765)
     ▼
[2] src/js/agent_bridge.js     ← 新規モジュール(dev 限定でロード)
     ├─ MSP.promise() による FC 読み書き
     ├─ FC オブジェクト(PIDS / RC_TUNING / FILTER_CONFIG)の読み取り・更新
     └─ switchTab() による UI 操作
```

新規作成は上記 2 つ。既存コードへの変更は「dev 時に agent_bridge を動的 import する」
1 箇所のみ(browser 起動パス)。

## コンポーネント 1: MCP ブリッジプロセス(`tools/mcp-bridge/`)

- `@modelcontextprotocol/sdk` による stdio MCP サーバーと、`ws` による
  WebSocket サーバーを 1 プロセスに同居させる。
- MCP ツール呼び出しを、接続中の Configurator タブへ JSON メッセージ
  `{ id, method, params }` として転送し、応答 `{ id, result | error }` を返す薄い中継。
- Configurator が未接続の場合は「Configurator が起動していない/ブリッジに接続されていない」
  旨のエラーを返す。
- WebSocket は `127.0.0.1` バインドのみ。dev 限定のため認証は省略。
- 複数タブが接続してきた場合は最後に接続したタブを有効とする(実験用途のため単純化)。

## コンポーネント 2: Configurator 側 agent モジュール(`src/js/agent_bridge.js`)

- `import.meta.env.DEV` が真のときだけ動的 import して起動する。
  プロダクションビルドのバンドルには含まれない。
- `ws://127.0.0.1:8765` へ接続し、切断時は数秒間隔で自動再接続
  (ブリッジと Configurator の起動順を問わない)。
- 受信した `method` をハンドラ表で処理し、結果を返す。
- FC 未接続時に接続が必要な method が呼ばれたら、LLM が状況を理解できる
  明確なエラーメッセージ(例: "FC not connected. Ask the user to connect first.")を返す。

## MCP ツールセット

### 読み取り系

| ツール | 内容 |
|---|---|
| `get_status` | Configurator と FC の接続状態、FC 情報(ファームウェアバージョン、機体名)、現在のタブ |
| `get_pid_tuning` | ロール/ピッチ/ヨー各軸の P・I・D・FF(`FC.PIDS` / `FC.ADVANCED_TUNING`) |
| `get_rates` | レート設定(`FC.RC_TUNING`) |
| `get_filters` | ジャイロ / D term フィルタ設定(`FC.FILTER_CONFIG`) |
| `list_tabs` | 切替可能なタブの一覧 |

### 書き込み系(部分更新方式)

| ツール | 例 |
|---|---|
| `set_pid_tuning` | `{ roll: { P: 47 }, pitch: { D: 38 } }` → 指定項目のみ変更 |
| `set_rates` | `{ roll_rc_rate: 1.2 }` |
| `set_filters` | `{ gyro_lowpass_hz: 100 }` |
| `save_to_flash` | `MSP_EEPROM_WRITE` で FC のフラッシュに保存 |

`set_` 系ツールの処理フロー(全ツール共通):

1. 対応する MSP 読み取りコードで最新値を FC から読み直す(古い状態への上書きを防ぐ)
2. ツール引数で指定された項目だけを FC オブジェクト上で上書き
3. `mspHelper.crunch(MSP_SET_*)` でペイロードを構築し `MSP.promise()` で送信
   - PID: `MSP_SET_PID` (202)
   - レート: `MSP_SET_RC_TUNING` (204)
   - フィルタ: `MSP_SET_FILTER_CONFIG` (93)
4. 変更後の値一式を返す(LLM がその場で結果を確認できる)

`save_to_flash` を呼ぶまで変更は FC の RAM 上のみ(揮発)。
「試して、ダメなら電源再投入で戻せる」挙動を意図的に保つ。

### UI 操作系

| ツール | 内容 |
|---|---|
| `switch_tab` | `src/js/tab_switch.js` の `switchTab(tabKey)` を呼ぶ |

### 低レベル脱出ハッチ

| ツール | 内容 |
|---|---|
| `msp_command` | MSP コード+ペイロードを直接送る(`MSP.promise(code, data)`)。ツール未対応の設定に将来アクセスするための予備。description に「上級者向け・通常は使わない」と明記 |

## 安全方針

- モーター試運転系(`MSP_SET_MOTOR` 等)の専用ツールは**作らない**。
- `save_to_flash` と `msp_command` のツール description に破壊的操作である旨を明記し、
  MCP クライアント側(Claude Code 等)の承認フローに乗せる。
- WebSocket は localhost のみ。外部ネットワークには一切公開しない。
- agent_bridge は dev ビルド限定。リリースビルドへの混入なし。

## エラーハンドリング

- ブリッジ ⇔ Configurator 間はリクエストごとに `id` を付け、タイムアウト(10 秒)で
  エラー応答を返す(MSP 応答が返らないケースへの防御)。
- FC 未接続・タブ切替不可(`GUI.connect_lock` 等)・不正なパラメータ名は、
  それぞれ原因がわかるエラーメッセージで LLM に返す。

## テスト・検証

- ブリッジ単体: WebSocket モッククライアントでツール呼び出しの往復を vitest で確認。
- E2E: `npm run dev` + ブリッジ起動 + Claude Code に `claude mcp add` で登録し、
  FC 実機(または VirtualFC)相手に以下を一通り実行:
  1. `get_status` → 接続状態が正しく返る
  2. `switch_tab` → 画面のタブが切り替わる
  3. `get_pid_tuning` → 現在の PID が返る
  4. `set_pid_tuning` で 1 項目変更 → PID タブの表示と一致する
  5. `save_to_flash` → 再接続後も値が保持される

## 検討済み・不採用の代替案

- **CLI コマンド注入方式**: Betaflight の全設定に触れる利点はあるが、
  ユーザーの要望(項目単位の構造化操作)により不採用。
- **ブラウザ自動化(Chrome DevTools MCP)方式**: コード変更ゼロで試せるが、
  DOM 操作は遅く脆いため PoC 用途に留め、本設計では採用しない。
- **MSP 直結スタンドアロン MCP サーバー**: シリアルポートが Configurator と
  排他になり、UI 操作もできないため不採用。
