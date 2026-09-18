# Hitoiki — 仕様書（Electron 版）

過集中を止めるための常駐アプリ。設定した間隔または時刻に全画面を数回フラッシュさせ、
その後一定時間オーバーレイで入力を遮る。macOS / Windows の両方で動く。作者本人が使う道具。

この文書が正。CLAUDE.md / AGENTS.md と矛盾したら SPEC.md を優先する。

---

## 1. 技術スタック

| 項目 | 選定 |
|---|---|
| ランタイム | Node.js 22 LTS |
| フレームワーク | Electron 最新安定版（メジャーを package.json に固定） |
| 言語 | TypeScript（`strict: true`）。ビルドは `tsc` のみ。バンドラーは使わない |
| テスト | vitest |
| パッケージ | electron-builder（発行時のみ） |
| 追加パッケージ | 上記以外は禁止。必要なら SPEC.md を先に更新する |

---

## 2. 機能要件

### F1 スケジュール
- `interval` モード: 起動（または再開）から `intervalMinutes` ごとに発火。既定 50。`0` で無効。
- `clock` モード: `clockTimes` の各時刻に発火。要素は "HH:mm" 文字列、または休憩秒数を
  個別に指定する `{ "time": "HH:mm", "breakSeconds": n }`。既定は空。
- 両モードは同時に有効化できる。両方が同じ分に発火する場合は 1 回にまとめる。
  まとめた発火の休憩秒数は clock 側を優先し、clock どうしが重なった場合は長いほうを使う。
- interval の起点: 起動・「再開」・スリープ復帰（`powerMonitor` の `resume`）ではその時刻から
  数え直す。設定の再読込（休憩時間の変更を含む）では起点を変えない。スリープ復帰時はタイマーを
  張り直す（停止中なら自動再開のタイマーを残り時間で張り直す）。
- 休憩中に到来した発火は破棄する（連続発火しない）。
- 次回発火時刻をトレイアイコンのツールチップに表示する。
- 実装は `setTimeout` で「次回発火までの ms」を 1 本だけ張る。`node-schedule` 等は使わない。

### F2 フラッシュ
- 全モニター同時（`screen.getAllDisplays()` の各 `bounds` に 1 枚ずつ `BrowserWindow`）。
- ウィンドウ設定: `frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true,
  hasShadow:false, resizable:false`。生成後に `setAlwaysOnTop(true, 'screen-saver')` と
  `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`。
- **Windows では `setFullScreen(true)` を使わない**（透明ウィンドウと相性が悪い）。
  `bounds` をディスプレイに合わせるだけにする。
- `flashCount` 回（既定 3）、`flashIntervalMs` 周期（既定 400）で点滅。
- **下限 334ms**（1 秒に 3 回を超えない）。設定値がそれ未満なら 334 に丸める。
- 色 `flashColor`（既定 `#FFFFFF`）、最大不透明度 `flashOpacity`（既定 0.85）。
- `fadeMode` が true のときは show/hide ではなく、レンダラー側で CSS transition により
  不透明度を 0 → max → 0 と変化させる。

### F3 休憩オーバーレイ
- フラッシュ終了後、同じウィンドウ群をオーバーレイとして残す。
- 背景は黒の半透明（`rgba(0, 0, 0, 0.85)`）。作業画面を見えにくくし、クリックを確実に受ける。
- 中央にその発火の休憩秒数のカウントダウンを大きく表示（120px 以上）。休憩秒数は clock 要素の
  `breakSeconds`、指定が無ければ全体の `breakSeconds`（既定 180）。
- `focus()` してキー入力・クリックをオーバーレイが受ける。`setIgnoreMouseEvents` は呼ばない。
  focus するのはカーソルのあるディスプレイのウィンドウ（macOS は `app.focus({ steal: true })` も呼ぶ）。
- 休憩中にフォーカスがオーバーレイのウィンドウ群から外れたら（Cmd+Tab / Alt+Tab 等）取り返す。
  OS の入力フックは使わないため、切り替え直後の一瞬のキー入力までは防げない。
- オーバーレイ表示中（フラッシュ・休憩とも）は、自前以外の close（Alt+F4 / Cmd+W 等）を
  `preventDefault` で拒否する。ウィンドウを閉じるのはカウントダウン終了と緊急解除のとき、
  およびアプリ終了時（`before-quit`。終了・ログアウト・シャットダウンを止めないため）だけ。
- 緊急解除: **Esc を 3 秒長押し**。押している間は進捗をリング表示する。
  keydown/keyup はレンダラーで検出し、preload 経由で main に `overlay:cancel` を送る。
- カウントダウン終了で全ウィンドウを `close()` し、次のスケジュールへ戻る。

### F4 トレイ
- 常駐。メインウィンドウは持たない。`window-all-closed` で終了しない。
- macOS では Dock に出さない（`app.dock.hide()`）。
- アプリケーションメニューは `Menu.setApplicationMenu(null)` で無くす（Cmd+Q / Cmd+W で休憩を
  抜けられないように）。終了はトレイの「終了」から行う。
- メニュー:
  - 今すぐ休憩
  - 休憩時間 ▸ 1 / 3 / 5 / 10 / 15 / 30 / 60 分（ラジオ）。選ぶと全体の `breakSeconds` を
    config.json に保存して設定を再読込する。clock 要素の個別の `breakSeconds` は変えない。
    現在値が一覧に無いときは、その値を 1 行足して選択状態で表示する。
  - 30 分間停止 / 再開
  - 設定ファイルを開く（`shell.openPath`）
  - 設定を再読込
  - 終了

### F5 設定
- パス: `path.join(app.getPath('userData'), 'config.json')`。
- 無ければ既定値で生成する。壊れていれば既定値で起動し、標準エラーに理由を出す。
- スキーマ（記入例。`clockTimes` の既定は空）:

```json
{
  "intervalMinutes": 50,
  "clockTimes": ["15:00", "17:30", { "time": "12:00", "breakSeconds": 3600 }],
  "flashCount": 3,
  "flashIntervalMs": 400,
  "flashOpacity": 0.85,
  "flashColor": "#FFFFFF",
  "fadeMode": false,
  "breakSeconds": 180
}
```

- 検証ルール: `intervalMinutes` 0（無効）または 1〜480、`flashCount` 1〜10、`flashIntervalMs` 334〜2000、
  `flashOpacity` 0.1〜1.0、`breakSeconds` 10〜3600（clock 要素の `breakSeconds` も同じ）。
  範囲外は最も近い境界値に丸める。
- `clockTimes` の要素で時刻が "HH:mm" でないものは除外する。要素の `breakSeconds` が
  数値でなければ全体の `breakSeconds` を使う。
- トレイの「休憩時間」から保存するときは `breakSeconds` キーだけを書き換え、他の項目と表記は保つ。
  ファイルが無ければ既定値で生成してから書く。壊れていれば書かずに標準エラーに理由を出す。
  書込に失敗しても終了せず、標準エラーに理由を出す。

---

## 3. 非機能要件

- 待機時 CPU ≒ 0%（ポーリング禁止）。
- 待機時はオーバーレイ用 BrowserWindow を生成しない（レンダラープロセスを持たない）。
- レンダラーは `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
  main との通信は preload で公開する最小 API（`onTick`, `onFlash`, `cancel`）だけ。
- OS レベルの入力フック（`BlockInput`、`CGEventTap`、`iohook` 等）は使わない。
- ネットワーク通信なし。
- ログイン時自動起動は v1 の対象外。

---

## 4. アーキテクチャ

```
package.json / tsconfig.json
src/
  main.ts            app ライフサイクル、トレイ、配線
  scheduler.ts       純粋ロジック。Electron を import しない
  config.ts          読み書き・既定値・検証。Electron を import しない（パスは引数で受ける）
  overlay.ts         BrowserWindow 群の生成と、フラッシュ → 休憩の状態遷移
  preload.ts         contextBridge で最小 API を公開
renderer/
  overlay.html       単一 HTML。CSS/JS を内包。外部リソースなし
test/
  scheduler.test.ts
  config.test.ts
dist/                tsc 出力（git 管理外）
```

- `scheduler.ts` は「現在時刻と設定を与えると次回発火時刻を返す」純粋関数を中心に作る。
  `Date.now()` を直接呼ばず、`now: () => Date` を注入する。
- `overlay.ts` の状態: `idle → flashing → breaking → idle`。`paused` は `idle` の変種。

---

## 5. 受け入れ条件

- [ ] `npm run build` が型エラーなしで通り、`npm test` が通る。
- [ ] Windows / macOS の両方で、2 モニター環境を含めて全画面にフラッシュが出る。
- [ ] macOS で他アプリがフルスクリーンのときもオーバーレイが上に出る。
- [ ] 休憩中はエディタやブラウザにキー入力が届かない。
- [ ] Esc 3 秒長押しで解除できる。短押しでは解除されない。
- [ ] `flashIntervalMs: 100` を設定しても点滅は 334ms 周期になる。
- [ ] 設定ファイルを消して起動すると既定値で再生成される。
- [ ] 待機中にアクティビティモニタ／タスクマネージャで Renderer プロセスが存在しない。

---

## 6. 既知の制約

- 配布物は 150MB 前後になる。許容する。
- 署名・公証はしない。macOS 初回起動は「開く」の手動承認で通す。
- Electron のメジャー更新は年 2〜3 回。追従は作者の判断で行い、エージェントは勝手に上げない。

---

## 7. 非目標

- 統計・ログの記録
- ポモドーロの細かな管理
- 複数プロファイル
- GUI の設定画面（JSON を直接編集する。例外はトレイの「休憩時間」選択のみ）
- 自動更新
- React / Vue 等のフロントエンドフレームワーク
