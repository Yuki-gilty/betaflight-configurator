# Betaflight Configurator × Claude 操作マニュアル

Claude(Claude Code / Claude Desktop)から日本語で Betaflight Configurator を操作するための使い方ガイドです。

「今のPID見せて」「ロールのPを2上げて」「保存して」のように話しかけるだけで、Claude が MCP ツールを通じて FC(フライトコントローラ)の設定を読み書きします。

---

## 1. 仕組み(ざっくり)

```
あなた ──日本語で指示──▶ Claude ──MCP──▶ 中継サーバー ──WebSocket──▶ ブラウザのConfigurator ──MSP──▶ FC
```

- Claude が使えるのは **開発モードで起動した Web 版 Configurator だけ**です(公開版・デスクトップ版では動きません)
- 設定変更は Configurator の各タブの「Save」ボタンと同じ内部処理(MSPプロトコル)を通ります。CLIコマンドは使いません

## 2-0. いちばん簡単な使い方(Node・ターミナル不要)

開発環境を持っていない人は、配布物2つをダブルクリックするだけで使えます:

1. **Betaflight App(デスクトップ版)** をダウンロードして起動
   (Tauriビルド: `npm run tauri:build` で作成した .dmg / .exe)
2. アプリの **オプション → 「AIエージェント(MCP)連携を有効にする」** をON
   - ONにすると同じ行に接続状態が表示されます: 🟢**接続中** / ⚪**AIエージェント待機中**
   - 接続/切断のたびに画面下のログにも「AIエージェント(MCP)が接続されました」と出ます
3. **betaflight-mcp.mcpb** をダブルクリック → Claude Desktopが開き「インストールしますか?」→ OK
   (.mcpbの作成: `npm run mcp-bridge:mcpb`。Claude DesktopはNode内蔵なのでユーザー側にNode不要)
4. Claude Desktopで「PID見せて」と話しかける

以降の章は開発環境(`npm run dev`)で使う人向けの説明です。

## 2. 初回セットアップ(1回だけ)

### 2-1. 依存のインストール

```bash
cd /Users/yukiyamamotopersonal/Repo/betaflight-configurator
npm install
```

### 2-2. Claude への登録

**Claude Code の場合:**

```bash
claude mcp add betaflight -- node /Users/yukiyamamotopersonal/Repo/betaflight-configurator/tools/mcp-bridge/server.js
```

**Claude Desktop の場合:** 設定ファイル(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`)に追記:

```json
{
    "mcpServers": {
        "betaflight": {
            "command": "node",
            "args": ["/Users/yukiyamamotopersonal/Repo/betaflight-configurator/tools/mcp-bridge/server.js"]
        }
    }
}
```

**Codex CLI の場合:** `~/.codex/config.toml` に追記:

```toml
[mcp_servers.betaflight]
command = "node"
args = ["/Users/yukiyamamotopersonal/Repo/betaflight-configurator/tools/mcp-bridge/server.js"]
```

このブリッジは標準の stdio MCP サーバーなので、Claude 以外の MCP 対応クライアント
(Codex など)からも同じ `node .../server.js` を指すだけで利用できます。

登録は1回だけでOK。以降はクライアントが必要なときに中継サーバーを自動起動します。
なお、WebSocketポート(8765)は共有のため、Configuratorに同時接続できるMCP
クライアントは1つだけです(先に使っている方を閉じれば、もう一方が自動で引き継ぎます)。

## 3. 毎回の使い方(3ステップ)

1. **Configurator を起動**

   ```bash
   npm run dev
   ```

   ブラウザで http://localhost:8080 を開く。
   接続確認したいときは、ブラウザの devtools コンソールに
   `[agent-bridge] connected to MCP bridge` が出ていればOK
   (中継サーバー未起動の間は3秒ごとに再接続を試みるので、順番は気にしなくて大丈夫)。

2. **FC を接続**

   いつも通り Configurator の画面上で FC に接続します(USBなど)。
   ※ FC 未接続でも `get_status` やタブ切替は使えます。

3. **Claude に話しかける**

   Claude Code(または Claude Desktop)を開いて、普通に日本語で指示するだけです。

## 4. 会話の例

そのままコピペして試せる指示の例:

| やりたいこと | Claude への指示の例 |
|---|---|
| 接続確認 | 「Betaflightの接続状態を教えて」 |
| PID を見る | 「今のPID設定を表で見せて」 |
| PID を変える | 「ロールのPを47にして。ピッチのDも2下げて」 |
| レートを見る/変える | 「レート設定を見せて」「roll_rate を 0.8 にして」 |
| フィルタを変える | 「ジャイロのローパスフィルタを100Hzにして」 |
| 保存する | 「今の変更をFCに保存して」 |
| 画面操作 | 「PIDチューニングのタブを開いて」「タブの一覧を見せて」 |
| 相談しながら調整 | 「プロップウォッシュが気になる。Dタームまわりで試す価値のある変更を提案して、順番に適用して」 |

**ポイント: 変更は保存するまで「お試し」状態です。** `set_〜` で変えた値は FC の RAM 上にだけ存在し、**バッテリーを抜く(電源を切る)と元に戻ります**。飛ばして確認してから「保存して」と言うのが安全な使い方です。

## 5. Claude が使えるツール一覧

Claude は状況に応じて自動でこれらを使います(あなたが直接呼ぶ必要はありません)。

### 読み取り(いつでも安全)

| ツール | 内容 |
|---|---|
| `get_status` | 接続状態・ファームウェア・機体名・現在のタブ |
| `get_pid_tuning` | ロール/ピッチ/ヨーの P・I・D・FF |
| `get_rates` | レート設定一式 |
| `get_filters` | ジャイロ/D term フィルタ設定一式 |
| `list_tabs` | 切替可能なタブの一覧 |

### 書き込み(FCのRAMに反映、保存は別)

| ツール | 内容 |
|---|---|
| `set_pid_tuning` | 指定した軸・項目だけ変更(例: `{ roll: { P: 47 } }`) |
| `set_rates` | 指定したキーだけ変更(例: `{ values: { roll_rate: 0.8 } }`) |
| `set_filters` | 指定したキーだけ変更(例: `{ values: { gyro_lowpass_hz: 100 } }`) |
| `save_to_flash` | **FCのフラッシュに保存**(これで電源を切っても残る) |

### UI操作・上級者向け

| ツール | 内容 |
|---|---|
| `switch_tab` | Configurator の画面タブを切り替える |
| `msp_command` | 生のMSPコマンド送信(通常は使わない脱出ハッチ) |

## 6. 安全について

- **モーターを回すツールはありません。** Claude 経由でモーターが回ることはない設計です
- `save_to_flash` と `msp_command` は破壊的操作として定義してあるので、Claude は実行前に確認を求めてきます
- 通信はすべて自分のPC内(127.0.0.1)で完結し、ネットワークには一切公開されません
- この機能は開発モード限定で、リリースビルドには一切含まれません
- **設定変更後の初フライトは必ず慎重に。** プロップを外してのアーム確認、広い場所での低高度テストなど、通常のチューニング時と同じ注意を払ってください

## 7. うまくいかないとき

| 症状 | 原因と対処 |
|---|---|
| Claude が「Configurator is not connected to the bridge」と言う | Configurator が開いていない → `npm run dev` してブラウザで http://localhost:8080 を開く。開いているのに繋がらない場合はブラウザのタブをリロード |
| Claude が「FC not connected」と言う | FC が Configurator に接続されていない → Configurator の画面で FC に接続する |
| `[agent-bridge] connected` がコンソールに出ない | 中継サーバーが起動していない → Claude 側で一度ツールを使わせる(MCPクライアントが自動起動する)か、動作確認として `npm run mcp-bridge` を手動実行 |
| 「Timed out waiting for Configurator response」 | ブラウザタブがスリープ/クラッシュしている → タブをアクティブにする、またはリロード |
| ポート8765が他のアプリと競合 | 中継サーバーは `BF_BRIDGE_PORT` 環境変数で変更可。ただし Configurator 側は 8765 固定なので、変える場合は `src/js/agent_bridge/index.js` の `DEFAULT_URL` も合わせて変更 |
| 変更したのに再起動したら消えた | 仕様です(§4のポイント参照)。残したい場合は「保存して」(`save_to_flash`) |

## 8. Blackbox自動チューニング(/bb-tune)

飛行ログ(Blackbox)の取得→解析→PID/フィルタの改善提案→適用を一言で行えます。

```
飛ばしてログを録る → 着陸してUSB接続 → Claude Codeで:
「ブラックボックス解析してPID改善して」(または /bb-tune)
```

Claude が自動で行うこと:

1. FCのフラッシュからログをダウンロード(`download_blackbox`、数MBで1分程度。進捗を報告)
2. `blackbox_decode` でデコードし、`tools/mcp-bridge/analyze_bbl.py` で解析
   (各軸のステップ応答: オーバーシュート/立ち上がり/整定、ジャイロノイズ、モーター飽和)
3. 結果を数値つきで説明し、PID/フィルタの変更案を提示(1回の変更は±10%以内・2〜3項目まで)
4. `set_pid_tuning` / `set_filters` でRAMに適用(保存はあなたが「保存して」と言ったときだけ)
5. 確認のうえ `erase_blackbox` で次のフライトに備える

**初回だけ必要な準備:**

```bash
pip3 install numpy scipy
git clone https://github.com/betaflight/blackbox-tools
cd blackbox-tools && make && cp obj/blackbox_decode /usr/local/bin/
```

手元に .bbl ファイルが既にある場合は「~/Downloads/xxx.bbl を解析して」でもOK(ダウンロード工程をスキップ)。

## 9. いまできないこと(今後の拡張ポイント)

- 対応している設定分野は **PID・レート・フィルタ** の3つ。OSD・モード設定・モーター構成などは未対応(必要なら `handlers.js` と `tools.js` に1分野ずつ追加できる設計)
- Blackboxダウンロードはオンボードフラッシュのみ対応。SDカードロギングの機体はカードを直接読む方が速い
- 公開版(app.betaflight.com)やデスクトップ(Tauri)版では使えない
- ブラウザタブは最後に開いた1つだけが有効(複数タブ同時操作は不可)
