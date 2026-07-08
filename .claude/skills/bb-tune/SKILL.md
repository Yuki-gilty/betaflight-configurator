---
name: bb-tune
description: Blackboxログの取得→解析→PID/フィルタ改善提案→適用まで行う(適用前に必ずユーザー承認)。ユーザーが「ブラックボックス解析して」「ログからPID改善して」「/bb-tune」と言ったら使う。.bblファイルパスが渡された場合はダウンロードをスキップして解析から始める。
---

# Blackbox自動チューニング

Betaflight MCPブリッジ(`betaflight` MCPサーバー)と解析スクリプトを使って、
ログ取得→解析→改善提案→適用を一気通貫で行う。

## 前提

- Configuratorが `npm run dev` で起動しブラウザで開かれ、FCが接続されていること
  (`get_status` で確認。ダメなら手順をユーザーに案内して待つ)
- `blackbox_decode` が必要(なければ `git clone https://github.com/betaflight/blackbox-tools && cd blackbox-tools && make` でビルドし、PATHに置くかフルパスで実行)
- Python: numpy / scipy

## 手順

1. **ログ入手**
   - ユーザーが .bbl のパスをくれた場合 → それを使い 3 へ
   - それ以外 → `get_blackbox_info` で usedSize を確認(0なら「ログがない。Blackboxを有効にして飛んできて」と案内して終了)
   - `download_blackbox` を呼び、`blackbox_download_status` を5〜10秒間隔でポーリング
     (数MBで1分程度かかる。進捗%をユーザーに随時報告)
2. **現在設定の取得**: `get_pid_tuning` / `get_filters` / `get_rates` で現状を控える
   - `get_pid_tuning` は `profile`(プロファイル番号・名前)、`pids`(各軸 P/I/D/D_MAX/FF)、
     `level`(Angle/Horizon)、`sliders`(スライダー位置)、`advanced`(TPA・アンチグラビティ・
     iterm relax・throttleBoost・feedforward詳細など)を返す。提案の根拠に advanced も使う
   - enum系の値は `_labels` に名前(PT1/BIQUAD、SETPOINT、ACTUAL等)が入っている
3. **解析**: `python3 tools/mcp-bridge/analyze_bbl.py <path.bbl> --json /tmp/bbl_analysis.json`
   を実行し、JSONを読む(.bblヘッダーのPID/フィルタ設定も入っている)
4. **解釈と提案** — 以下の目安で各軸を判定:
   - overshoot_pct > 15% → P過剰またはD不足。Dを5〜10%上げるかPを5%下げる
   - overshoot_pct < 0〜3% かつ rise_time が遅い(>25ms) → P不足。Pを5〜10%上げる
   - トレース末尾が1.0に届かない/ゆっくり漸近 → I不足。Iを10%上げる
   - トレースに減衰振動 → Dを上げる。ただしgyro_noiseの80-200Hz帯が大きい場合はDを上げる前にフィルタ(dterm_lowpass)を検討
   - プロップウォッシュ由来の揺れ → D_MAX(各軸)や dMaxGain の引き上げも選択肢(set_pid_tuning の D_MAX / set_advanced_tuning)
   - 高スロットルでのみ振動 → PIDではなく TPA(advanced の tpaRate/tpaBreakpoint)を先に見る
   - フリップ/ロール後の跳ね返りが I 由来 → itermRelax の設定(advanced)も確認する
   - gyro_noise の dominant_peak_hz が明確(モーターノイズ)で0-80Hz帯まで漏れている → フィルタ強化を提案
   - motors.saturated_pct > 5% → 出力飽和。PIDを上げる提案はしない
   - windows_used が少ない(<10)軸は信頼度が低いと明記する
   - 一度に変える量は各項目±10%以内、変更は2〜3項目までに絞る(反復チューニング前提)
5. **提示と承認(必須ゲート)**: 現在値→提案値の表(下の形式)と根拠(数値つき)を日本語で提示し、
   **「この内容で適用していいですか?」と必ず聞く。ユーザーが明示的にOKするまで `set_` 系は一切呼ばない。**
   一部だけ適用したい・値を調整したいと言われたら、表を作り直して再度確認する。

   | 軸 | 項目 | 現在 | 提案 | 根拠 |
   |---|---|---|---|---|
   | Roll | P | 45 | 47 | 立ち上がり28msと遅め |

6. **適用**: `set_pid_tuning` / `set_filters` / `set_advanced_tuning`(TPA等)で適用(RAMのみ)。適用後の値を読み返して確認
7. **締め**: 以下を必ず伝える
   - 変更はRAM上のみで、電源再投入で元に戻ること
   - 試験飛行して良ければ「保存して」で `save_to_flash` すること(勝手に保存しない)
   - 次のログのために `erase_blackbox` するか確認(ダウンロード済みであることを確かめてから)

## 安全ルール

- **PID/フィルタの変更(`set_` 系)はユーザーの明示的な承認なしに呼ばない(ステップ5のゲートを飛ばさない)**
- `save_to_flash` と `erase_blackbox` はユーザーの明示的な同意なしに呼ばない
- 解析結果が不十分(飛行時間 < 30秒、windows_used がすべて僅少)なら、
  変更を適用せず「もっと動きのあるログを録ってきて」と案内する
