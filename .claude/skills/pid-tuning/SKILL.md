---
name: pid-tuning
description: Betaflight のPID・レート・フィルタチューニングのドメイン知識。ユーザーが機体の挙動(振動・プロップウォッシュ・ドリフト・跳ね返り・モーター発熱・もっさり感など)を相談したり、PID/フィルタ値の意味・変更方針を尋ねたときに使う。set_pid_tuning等で実際に値を変える前の判断根拠として参照する。実ログ解析を伴う場合は bb-tune スキルと併用する。
---

# Betaflight PIDチューニング知識

FCの挙動を診断し、PID・レート・フィルタの変更方針を決めるための知識。
実際の値の読み書きは MCP ツールで行い、飛行ログを使う場合は [[bb-tune]] の解析結果と併せて判断する。

## MCPツールと読めるデータの対応

| ツール | 読める/書ける内容 |
|---|---|
| `get_pid_tuning` | `profile`: PID/レートプロファイル番号と名前。`pids`: 各軸の P/I/D/D_MAX/FF。`level`: Angle/Horizon の強さ・transition・angleLimit。`sliders`: 簡易チューニングスライダー位置(100 = UI表示1.0。slider_pids_mode は _labels で OFF/RP/RPY)。`advanced`: TPA(tpaMode/tpaRate/tpaBreakpoint)、アンチグラビティ(antiGravityGain=UI表示×10/antiGravityMode)、iterm relax(itermRelax/itermRelaxType/itermRelaxCutoff)、itermRotation、throttleBoost、dMaxGain/dMaxAdvance、feedforward_*(averaging/smooth_factor/boost/jitter_factor/max_rate_limit/Transition)、motorOutputLimit、idleMinRpm(Dynamic Idle ×100RPM)、thrustLinearization、vbat_sag_compensation、acroTrainerAngleLimit、useIntegratedYaw、autoProfileCellCount、absoluteControlGain など |
| `set_pid_tuning` | 軸ごとの P/I/D/D_MAX/FF(例: `{ roll: { P: 47, D_MAX: 40 } }`) |
| `set_advanced_tuning` | 上記 advanced のキーを部分更新(例: `{ values: { tpaRate: 0.6 } }`) |
| `get_filters` / `set_filters` | gyro/dterm ローパス(静的+動的min/max)、ノッチ、ダイナミックノッチ(dyn_notch_*)、RPMフィルタ(gyro_rpm_notch_*)。`_sliders` にフィルタ乗数スライダー(enabled + multiplier、100=1.0)|
| `get_rates` / `set_rates` | レート一式(rates_type、スロットルカーブ、スロットルリミット含む) |

enum系フィールドは戻り値の `_labels` に名前が入る(フィルタタイプ PT1/BIQUAD/PT2/PT3、
itermRelaxType GYRO/SETPOINT、rates_type BETAFLIGHT/ACTUAL 等)。生値と併せて解釈に使う。
注: `sliders`・`_sliders`(スライダー位置)と `level`(Angle/Horizon)、`profile` は現状**読み取り専用**。
書き込みは各軸PID(set_pid_tuning)・advanced(set_advanced_tuning)・フィルタ/レートの個別値で行う。

## 大原則

- **一度に変えるのは1つ**(または1分野)。複数同時に変えると原因の切り分けができない
- **変更は小刻みに**(各項目 ±10〜15%以内)。チューニングは反復作業
- **フィルタが先、Dが後**。ノイズが多い状態でDを上げるとモーターが発熱し危険
- **モーター発熱は最優先の危険信号**。着陸直後にモーターが熱い→即中断してノイズ/D/フィルタを見直す
- 変更は `save_to_flash` するまでRAMのみ。飛ばして確認→良ければ保存、が安全な流れ

## 各項の役割と症状

### P(Proportional)— 主たる補正力
- **高すぎ**: 高周波の振動、急な舵やスロットルで発振、モーター発熱
- **低すぎ**: 反応が鈍い、フワフワして舵が「つながらない」、外乱に弱い
- 上げていって発振する直前まで上げ、そこから10〜15%戻すのが基本

### I(Integral)— 姿勢の保持力
- **高すぎ**: フリップ/ロール後にゆっくり跳ね返る(I-term bounce)、低周波のうねり、風での揺り戻し
- **低すぎ**: 舵を戻しても角度が保持されずドリフトする、風で流される
- ドリフト・保持不足はほぼ I の領域

### D(Derivative)— Pの制動・急変への抵抗
- **高すぎ**: モーター発熱、高周波ノイズの増幅(D-term noise)、キビキビしすぎて神経質
- **低すぎ**: P由来のオーバーシュート/発振、**プロップウォッシュ**(下降時・自機の乱流での揺れ)
- P と D はおおむね連動(P:D ≈ 1:0.7 が目安、機体で変わる)。Pを上げたらDも要見直し

### FF(Feedforward)— 舵の動きの速さに反応
- スティック入力の変化率に反応し、Pを上げずに追従を鋭くする
- **高すぎ**: 舵を入れた瞬間にオーバーシュート、カクつく感じ
- **低すぎ**: 舵に対する初動が遅れる
- ラップタイム/レース用途で効く。フリースタイルは控えめでも良い
- 詳細調整(advanced): `feedforward_smooth_factor`(RCリンクのガタつき吸収、上げると滑らか/遅い)、
  `feedforward_jitter_factor`(スティック微動のノイズ抑制)、`feedforward_boost`(舵の入れ始めのキック)、
  `feedforward_averaging`(ノイジーな受信機なら 2_POINT 以上)

### D_MAX — Dの上限値(各軸)
- 通常飛行では D(=下限側)で飛び、急な動き・プロップウォッシュ時に D_MAX まで自動で引き上がる
- **プロップウォッシュ対策で D を常時上げたくないときに D_MAX を上げる**のが定石
- `dMaxGain`: D→D_MAX への遷移の効き(ジャイロの動きに応じる)、`dMaxAdvance`: セットポイント(舵)に応じた先行
- D_MAX = 0 の軸は D 固定で動作する(ヨーは 0 が既定)

## 高度なパラメータ(advanced)の役割

### TPA(Throttle PID Attenuation)
- 高スロットルで PID(主にD、モードによりP+D)を減衰させ、**高スロットル時の振動・発振を抑える**
- `tpaRate`: 減衰の強さ(0.65 = 最大65%減)、`tpaBreakpoint`: 減衰を始めるスロットル位置(µs, 例 1350)
- `tpaMode`: PD か D のみか(`_labels` 参照)
- **症状**: パンチアウトやフルスロットルでのみ振動する → PIDを下げる前に TPA を強める(rateを上げる/breakpointを下げる)

### アンチグラビティ(Anti-Gravity)
- スロットルの急変時に I term を一時的にブーストし、**機首のお辞儀(Iの取りこぼし)を抑える**
- `antiGravityGain` が主パラメータ。スロットル急開閉でピッチがフラつくなら上げる
- 上げすぎると急スロットル時に振動やツンとした動きが出る

### I-term Relax
- 急舵中に I の蓄積を止め、**フリップ/ロール後の跳ね返り(bounce back)を抑える**
- `itermRelax`(_labelsで RP/RPY 等)= 対象軸、`itermRelaxType`(GYRO/SETPOINT)、
  `itermRelaxCutoff` = 効き始めの速さ(低いほど強く効く。既定15前後)
- 跳ね返りが残るなら cutoff を下げる(例 15→10)。レースでキレを求めるなら SETPOINT が一般的

### その他
- `throttleBoost`: スロットル応答を鋭くする。上げすぎるとスロットルでノイズを拾う
- `motorOutputLimit`: モーター出力上限%(過熱・過パワー機体を抑える)
- `thrustLinearization`: 低スロットルの推力カーブ補正。低回転での効きが良くなるがノイズも増える
- `vbat_sag_compensation`: バッテリー電圧低下による垂れを補正(0-100%)

## 症状 → 対処の早見表

| 症状 | 主な原因 | 対処 |
|---|---|---|
| 急な舵・フルスロットルで高周波振動 | P高すぎ or ノイズ | Pを下げる。まずフィルタ/ノイズ確認 |
| 高スロットル時だけ振動する | TPA不足 | tpaRateを上げる/tpaBreakpointを下げる(PIDより先に) |
| スロットル急開閉で機首がお辞儀する | アンチグラビティ不足 | antiGravityGainを上げる |
| 下降時・自機の乱流でガタつく(プロップウォッシュ) | D不足・FF不足・制動不足 | D_MAXを上げる(発熱に注意)、dMaxGainも検討 |
| 舵を戻した後ゆっくり跳ね返る | I高すぎ or I-term Relax弱い | itermRelaxCutoffを下げる、それでもならIを下げる |
| 舵を戻すと角度が保持されず流れる | I不足 | Iを上げる |
| フワフワ・舵がつながらない | P/FF不足 | P(必要ならFF)を上げる |
| モーターが熱い | D高すぎ / ノイズをDが増幅 | フィルタ強化→それでもならD下げる |
| キビキビしすぎ・神経質 | P/D/FF過剰 | 該当項を下げる |

## フィルタの考え方

- **フィルタは遅延(位相遅れ)を生む**。遅延が増えるとDを高く保てなくなる ⇒ フィルタとDはトレードオフ
- **弱いフィルタ = 反応は鋭いがノイズを拾う / 強いフィルタ = 滑らかだが遅く、プロップウォッシュに弱い**
- 基本方針: ジャイロがきれいな機体(良いモーター/プロペラ/防振)は弱めのフィルタで攻められる
- 主なもの:
  - `gyro_lowpass` / `dterm_lowpass`(ダイナミックLPF: min/max Hz)— 全体のノイズ床
  - dynamic notch(`dyn_notch_*`)— モーター回転由来のピークを追従除去
  - RPM filter(要双方向DShot)— 最も効くモーターノイズ対策。使えるなら最優先
- ログの gyro ノイズで **明確なピーク周波数がありローパスまで漏れている → まずフィルタ**。広帯域ノイズなら機械要因(プロペラ破損・アンバランス・緩み)を疑う

## ログ(bb-tune)指標の読み方

- **overshoot > 15%**: P過剰またはD不足。Dを5〜10%上げるかPを5%下げる
- **overshoot ほぼ0かつ rise_time > 25ms**: 反応が鈍い。Pを5〜10%上げる
- **ステップ応答の末尾が1.0に届かない/だらだら漸近**: I不足
- **減衰振動が残る**: D不足(ただし高周波ノイズが大きければ先にフィルタ)
- **motors.saturated_pct > 5%**: 出力飽和。この状態でPIDを上げる提案はしない(まず原因の負荷を減らす)
- **windows_used が少ない(<10)軸**: サンプル不足で信頼度が低い。断定しない

## チューニングの進め方(推奨順)

1. まず普通に飛ばしてBlackboxログを取る(動きのある飛行を30秒以上)
2. ノイズ/フィルタを整える(RPMフィルタ→dynamic notch→LPF)。モーター発熱をまず解消
3. P を上げていき、発振直前で止めて少し戻す
4. D をプロップウォッシュが取れるところまで(発熱と両にらみ)
5. I をドリフト/保持感で微調整
6. 必要なら FF で舵の初動を詰める
7. 各段階で飛ばして確認 → 良ければ保存

## 安全

- 変更後の初フライトは慎重に。プロップを外したアーム確認、広い場所での低高度テストから
- モーターが熱い/焦げ臭い → 即着陸・中断
- 大きく外れた値を一度に入れない。特に P/D を同時に大きく上げると発振・墜落・パーツ破損につながる
