# AGENTS.md — Hitoiki（Electron 版）

Codex（ASTRA）向けの作業指示。仕様は SPEC.md が正。矛盾を見つけたら SPEC.md を優先し、
矛盾の内容を報告する。

## プロジェクト概要

過集中を止めるための常駐アプリ。設定した間隔／時刻に全画面をフラッシュさせ、その後
オーバーレイで入力を遮る。Electron + TypeScript。macOS と Windows で動く。
作者本人だけが使うので、配布用の署名や自動更新はいらない。

## 環境とコマンド

```bash
node --version                 # 22.x であること
npm ci                         # ネットワークが要る。サンドボックスで失敗したら承認を求める
npm run build                  # tsc -p tsconfig.json → dist/
npm test                       # vitest run
npm start                      # electron dist/main.js。作者が手元で実行する。Codex は実行しない
```

package.json の `scripts` は上記に `dist`（electron-builder）を加えた 5 つに限る。

## サンドボックスでの注意

- `npm start` はウィンドウを開いて返ってこない。**実行しない**。検証は `npm run build` と
  `npm test` で行い、GUI の確認は作者に委ねる。
- `npm ci` / `npm install` はネットワーク承認が要る。承認を求める前に、何をなぜ取得するのかを
  1 行で書く。Electron 本体のダウンロードは数十 MB ある。
- 時間のかかるコマンドは 1 回の呼び出しで完結させ、対話的なコマンドは使わない。

## 作業の進め方

1. 着手前に **計画** を出して承認を待つ。計画は「触るファイル」「変更点」を合わせて 5 行以内。
2. 1 回の依頼で扱うのは SPEC.md の機能 1 つ（F1〜F5 のいずれか）まで。
3. 実装後、`npm run build` と `npm test` を通してから報告する。通らないまま報告しない。
4. 報告は「やったこと／確認方法／残り」の 3 項目。各項目 3 行以内。
5. 判断が必要な箇所は勝手に決めず質問する。質問は一度に 1 つ。
6. 作業の推奨順: config → scheduler（テスト込み）→ overlay.html → overlay.ts → main.ts / トレイ。
7. 機能 1 つごとに 1 コミット。メッセージは `feat(F2): flash all screens` の形式。
   `package-lock.json` の変更は依存を追加したコミットにだけ含める。

## 使ってよいもの・禁止

- 標準のファイル操作とシェルだけを使う。
- **プラグイン、スキル、外部エージェント、MCP サーバーは使わない。**
- npm パッケージの追加は SPEC.md §1 に無いものは事前に確認する。`electron-forge`、
  `electron-vite`、テンプレート生成ツールは使わない。
- `scheduler.ts` と `config.ts` から `electron` を import しない（テスト可能性を守る）。
- レンダラーで Node API を使わない。`nodeIntegration` を有効にしない。
- OS の入力フック（`iohook`、`node-global-key-listener` 等）は使わない。
- Electron のバージョンを勝手に上げない。
- 依頼されていないファイルの整形・リファクタをしない。差分は依頼範囲に限る。

## コーディング規約

- `tsconfig`: `strict: true`、`noUncheckedIndexedAccess: true`、`module: commonjs`、`target: es2022`。
- 時刻は `now: () => Date` を注入し、`Date.now()` を直接呼ぶのは `main.ts` だけ。
- IPC のチャンネル名は `overlay:` 接頭辞で統一し、`src/ipc.ts` に定数として置く。
- `overlay.html` は 1 ファイルで完結させる。外部 CSS/JS、CDN 参照はしない。
- 例外を握るのは Config の読み書きだけ（読込は既定値にフォールバック、書込は何もしない。どちらも標準エラーに理由を出す）。
  例外として、既に破棄したオーバーレイウィンドウの読込中断（`loadFile` の reject）だけは無視してよい。
  まだ使っているウィンドウのエラーは投げ直す（`overlay.ts` の `load`）。
- 識別子とコード内コメントは英語。ユーザーとのやり取りは日本語。

## 手動検証（作者が行う）

Codex は GUI を起動できないので、以下は作者が確認する。報告には「作者が確認する項目」として書く。

- 2 モニターでフラッシュが両方に出るか
- macOS で他アプリのフルスクリーン上にも出るか
- 休憩中にエディタへ文字が入らないか
- Esc 長押し 3 秒で解除、短押しでは解除されないか
- 待機中に Renderer プロセスが無いか

## やらないこと

SPEC.md §7 の非目標に加えて、次はやらない。

- 「ついでに」の改善提案を実装すること（提案は報告の末尾に 1 行でよい）
- CI 設定、GitHub Actions の変更（依頼があるまで）
- README の執筆（依頼があるまで）
