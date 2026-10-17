# WSL Codex GUI — 作業開始時に必ず行うこと

このファイルはAIコーディングツール共通の規約(AGENTS.md)。このプロジェクトで作業するAIツール(種類は問わない)は、作業開始時にこの内容を読み込み、省略せず従うこと。

## 0. ソースを触る前にリモートを確認する

このリポジトリは複数マシン(`C:\Users\user\...`・`C:\Users\user\...`)から並行して触られる。ソースを1行でも編集する前に、まず

```
git fetch origin
git log HEAD..origin/master --oneline
```

でリモートが先行していないか確認する。先行していれば先に`git pull`/`git rebase`で追従してから作業を始める。プッシュ直前ではなく、**作業を始める前**に確認すること。

## 1. codex CLI側の仕様変更を検知する

WSL側の`codex` CLIは、このアプリが検証していないバージョンへ勝手に更新されていることがある。**ソースに何か変更を加える前に**、以下を行う。

1. 現在のバージョンを確認する:
   ```
   wsl -d <distro> --exec <codex絶対パス> --version
   ```
2. [app/src/codexVersion.ts](app/src/codexVersion.ts)の`CONFIRMED_CODEX_CLI_VERSIONS`配列の最後のエントリと比較する。
3. **一致していれば** — 何もせず、依頼された作業に進んでよい。
4. **バージョンが変わっていれば**(未確認バージョンになっていれば)、依頼された作業に着手する前に、次の検証を行う:
   - **プロトコル差分**: [app/scripts/codex-protocol.mjs](app/scripts/codex-protocol.mjs)で、現在の`generate-ts`出力をリポジトリ内の基準[docs/codex-protocol-baseline/](docs/codex-protocol-baseline/)(`VERSION`ファイルに生成元のcodexバージョンを記録)と機械的に比較する。**PowerShellから**実行すること(Git BashだとMSYSが`/home/...`をWindowsパスに書き換える):
     ```
     cd app
     node scripts/codex-protocol.mjs --codex <codex絶対パス> [--distro <distro>]
     ```
     終了コード0=差分なし、1=差分あり、2=実行エラー。差分があれば追加/削除/変更ファイルが一覧され、このアプリが直接依存する型(★)はメソッド名の増減と差分も表示される(全件は`--full`)。★の型の変化は、[app/src/schemas.ts](app/src/schemas.ts)・[app/src/types.ts](app/src/types.ts)、および`App.tsx`内の`method: "..."`と突き合わせて影響を判断する。`--baseline <dir>`で別の基準ディレクトリ(過去コミットから取り出したものなど)と読み取り専用で比較できる(`--save`とは併用不可)。
   - **実機回帰テスト**: [app/scripts/regression/codex-regression.mjs](app/scripts/regression/codex-regression.mjs)で、アプリ自身の`schemas.ts`・`sandboxConfig.ts`を使って実際のapp-serverに問い合わせ、initialize・thread/start(`approvalPolicy: "untrusted"`・sandbox・config付き)・thread/list・thread/read・model/listの応答検証と、workspace-write下で`.git`へコミットできるかを確認する。これも**PowerShellから**実行する:
     ```
     cd app
     node --no-warnings scripts/regression/codex-regression.mjs --codex <codex絶対パス> [--distro <distro>] [--skip-turn]
     ```
     終了コード0=全件成功、1=失敗あり、2=実行エラー。`--skip-turn`はモデル呼び出しを伴う`.git`コミット確認だけを省略する。テスト用スレッドと作業ディレクトリ(`/tmp/wslcodexgui-regression-<pid>`)は終了時に削除される。
   - `wsl -d <distro> --exec <codex絶対パス> --help`と`... app-server --help`の出力を確認し、既知のオプション一覧と食い違いがないか確認する(こちらは基準を保存していないため目視)
   - 上記で足りない気になる挙動(承認まわり・サンドボックスまわりなど)があれば、実機で再現・確認する。推測でコードを書かない。使い捨ての実験は[poc/](poc/)(git管理外・そのマシン限り)でよいが、**次回以降も繰り返す価値がある確認は`app/scripts/regression/`に置いてコミットする**(poc/に置くと他のマシンには存在せず、毎回書き直しになる)
5. 検証の結果、このアプリの挙動に影響する変更が見つかった場合は、**いきなり直さず**、原因と対処案をユーザーに提示し、実行してよいか確認してから着手する(2節参照)。影響がないと判断した場合は、`CONFIRMED_CODEX_CLI_VERSIONS`に新バージョンを追加し、**同じコミットで基準も更新する**(`node scripts/codex-protocol.mjs --codex <codex絶対パス> --save`)。基準の更新を忘れると、次回は今回の変更も「差分」として再検出される。影響がある変更を直す場合も、直した後で同様に基準を更新する。

基準はリポジトリ内にあるため、複数マシンで共有される(どのマシンで更新してもよい)。codexのバージョンが基準の`VERSION`と同じなのに差分が出る場合は、基準が古い、または`generate-ts`の出力が非決定的になった可能性があるので、まずその点を疑う。

## 2. 修正・ビルド・配置は必ず提案してから実行する

過去に、原因診断→修正→ビルド→配置を確認なしに一気に実行し、その過程でユーザーが使用中のアプリを断りなく強制終了した事故があった。二度と繰り返さないこと。

- 原因が分かった時点で止まり、「こうすれば直りますが、実行しますか」とユーザーに確認する
- ビルド・配置に進んでよいと言われた場合でも、**配置対象のexeを使用中のプロセスがないか確認**し、動いていれば終了してよいか確認してから止める
- コミット・プッシュも、実行してよいと明示的に言われてから行う

## 3. バージョン運用

機能・修正のたびに`package.json`・`package-lock.json`(2箇所)・`src-tauri/tauri.conf.json`・`src-tauri/Cargo.toml`・`src-tauri/Cargo.lock`の5ファイルの`version`を同じ値へ更新する。手で書き換えず、`app`で次を使う(内容一致で置換し、最後に整合チェックまで行う):

```
npm run bump-version -- patch      # 0.5.50 → 0.5.51
npm run bump-version -- 0.6.0      # 明示指定
```

`check-version-sync.mjs`(`npm run build`/`npm test`の前に自動実行)は、5ファイルの不一致に加えて、`CONFIRMED_CODEX_CLI_VERSIONS`の最後のエントリと`docs/codex-protocol-baseline/VERSION`の不一致もエラーにする(1節の「同じコミットで基準も更新する」の強制)。

修正内容は[docs/残項目.md](docs/残項目.md)末尾の完了ログに、日付見出し・タイトル(バージョン番号付き)・きっかけ・原因・修正内容・テスト結果の形式で追記する。実機配置が完了したら、配置状態の行(文書冒頭)を更新する別コミットを作る(機能コミットと配置状態コミットは分ける、既存の慣習)。
