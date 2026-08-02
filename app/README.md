# WSL Codex GUI

[Codex CLI](https://github.com/openai/codex) の `app-server` を、Windowsネイティブの
GUI（Tauri 2 + React）から操作するためのラッパーアプリです。接続方式は2種類選べます。

- **WSLモード**（既定）: Codexの実行環境（設定・認証・ツールチェーン・プロジェクトファイル）をすべてWSL側に
  置き、Windows側は表示と入力に専念します。`wsl.exe`の子プロセスを標準入出力パイプで直結する方式です。
- **Windows-nativeモード**: Windows側に直接インストールしたCodex CLI（`@openai/codex`が公式配布している
  `codex-win32-x64`等）を、`wsl.exe`を介さず直接子プロセスとして起動します。

どちらの方式でもネットワークポートは一切使いません（子プロセスの標準入出力パイプで直結する方式）。

設計の背景・検証結果は [../docs/仕様書.md](../docs/仕様書.md) を参照してください。このREADMEは実装済みの
アプリを**セットアップ・実行・配布**するための実用ドキュメントです。

## 目次

- [主な機能](#主な機能)
- [動作要件](#動作要件)
- [新しいPCへの導入手順](#新しいpcへの導入手順)
- [開発コマンド](#開発コマンド)
- [初回起動時の設定](#初回起動時の設定)
- [トラブルシューティング](#トラブルシューティング)
- [アーキテクチャ概要](#アーキテクチャ概要)
- [リポジトリ構成](#リポジトリ構成)

## 主な機能

- **チャット**: `thread/start`〜`turn/start`〜`turn/completed`の流れをGUIで操作。アシスタント応答は
  Markdownとして整形表示（react-markdown + remark-gfm）
- **接続方式の選択**: サイドバーの「接続方式」でWSL／Windows-nativeを切り替え。接続前は接続パネルのみの
  最小画面（プロバイダ・接続方式・codexパス・モデル・推論レベル・速度・接続ボタン）が表示され、初回接続に
  成功すると通常のフル画面（プロジェクト・スレッド一覧・チャット）に切り替わる
- **モデル・推論レベル・速度の指定**: モデルはGPT-5.6-Sol/Terra/Lunaのプリセット（「その他」で任意ID入力も
  可）から選択。推論レベル（`effort`）・速度（`serviceTier`）は接続前に指定でき、接続後もフッターの🎚/🚀
  バッジからいつでも変更可能（次のメッセージから反映。スレッド再読み込み不要）。GPT-5.6-Lunaを選ぶと推論
  レベルは自動で「最大」に、Sol/Terraを選ぶと自動で「高い」になる（選択時の既定であり、その後手動で変更できる）
- **スレッド管理**: 一覧表示・再開（`thread/resume`）・インライン名前変更（`thread/name/set`）。未接続時に
  スレッドを選ぶと「接続しますか？」の確認ダイアログを出してから接続
- **プロジェクト選択**: WSLモードではWindowsのフォルダ選択ダイアログから`\\wsl.localhost\<distro>\...`を
  選択しWSLパスへ変換して登録、Windows-nativeモードでは選んだWindowsパスをそのまま使用。スレッドを開くと
  そのスレッド自身の`cwd`に追従
- **承認UI**: `item/commandExecution/requestApproval`等のリクエストに含まれる`availableDecisions`
  配列から、そのリクエストで実際に有効な選択肢だけを動的にボタン化
- **Stop**: `turn/interrupt`のみを送信し、app-serverプロセス自体は終了しない
- **「/」コマンド補完**: `/new` `/goal <text>` `/compact` `/diff` `/status` `/copy` `/model` `/stop`
  `/usage` `/help`。↑↓で選択、Tab/Enterで実行、Escで閉じる
- **使用量バッジ**: 接続時・ターン完了ごとに`account/rateLimits/read`を自動取得し、フッターに残量%を常時表示
  （Codex公式アカウント画面と同じ「残り○%」表記）。プラン枠を使い切り購入クレジットの消費が始まった場合は、
  残クレジット残高を別色のバッジで表示
- **ターミナル / エクスプローラーを開く**: 選択中のプロジェクトパスに対してワンクリックで起動（WSLモードは
  WSL端末・`\\wsl.localhost\...`、Windows-nativeモードは`cmd.exe`・通常のフォルダウィンドウ）
- **ドラッグ&ドロップ**: エクスプローラーからファイルをドロップすると、WSLモードではWindows
  パスを自動でWSLパス（`/home/...`）に変換して挿入（選択中とは別のWSLディストリのUNCパスは拒否）、
  Windows-nativeモードではWindowsパスをそのまま挿入。ドロップ位置は問わない（ウィンドウ内ならどこでも
  コンポーザーに入る）ため、ドラッグ中はウィンドウ全体をハイライトする
- **transcript内リンク**: 応答中のリンクはクリックで開く（URLは既定ブラウザ、ファイルはWSLモードなら
  `\\wsl.localhost\...`経由）。codexが書く`src/App.tsx:42`のような行番号付き（`:行`、`:行:桁`、`#L42`）も
  行番号を取り除いて開く。右クリックで「リンク先を開く」「エクスプローラーでリンク先のフォルダを開く」
  「リンクアドレスをコピー」を選べる（コピーされるのは解決後の絶対パス＋行番号）
- **推論経過の一時表示**: ターン実行中、`item/reasoning/summaryTextDelta`で流れてくる推論要約を
  transcriptとコンポーザーの間の一時ペイン（💭 推論経過）に表示。ターンが終わると消える（完了した推論要約は
  従来どおりtranscriptに残る）。折り畳み可能で、状態は次回以降も保持される。要約を得るため`turn/start`に
  `summary: "detailed"`を毎ターン送っている（`~/.codex/config.toml`の設定は不要）。実際に推論が起きなかった
  ターンでは要約自体が生成されないため、ペインは出ない
- **コピー**: チャット右上の📋ボタンで、表示中の会話（ユーザー発言・応答・思考・コマンドと出力・
  ファイル変更）をプレーンテキストでクリップボードへコピー。個々のメッセージにマウスを乗せると、そのメッセージ
  だけをコピーする📋ボタンが右上に現れる。直前の応答だけなら`/copy`でも可
- **画像貼り付け**: クリップボード画像を`Ctrl+V`で添付。保存中は送信を待たせ、接続・ディストリ（または
  接続方式）・スレッドをまたぐ誤添付を防止。一時画像（WSLモードは`/tmp`、Windows-nativeモードは`%TEMP%`）は
  取り消し・turn完了・切断時に削除
- **離席中の完了通知**: ターンが完了したとき、**デスクトップ全体で**5秒以上キーボード・マウス操作がなければ
  ウィンドウとタスクバーボタンを点滅させる（`GetLastInputInfo`で判定）。マウスを動かすかキーを押せば点滅は
  止まる（アプリを操作する必要はない）。アプリが既にフォーカスされている場合はOSの仕様上点滅しない
- **日本語IME対応**: 変換確定前のEnterで誤送信しない

## 動作要件

### Windows側

| 項目 | 要件 |
|---|---|
| OS | Windows 10/11、WSL2が有効なこと |
| Rust | `rustup`経由の最新stable（**1.75以上必須**。開発時は1.97.1で確認済み。Tauri 2は古いRustではビルドできない） |
| Node.js | 18以上（開発時はv22.18.0で確認） |
| MSVC Build Tools | Visual Studio Build Tools（または Visual Studio）の「C++によるデスクトップ開発」ワークロード |
| WebView2 Runtime | Windows 11は標準搭載。Windows 10は別途インストールが必要な場合あり |

### WSL側（WSLモードを使う場合）

| 項目 | 要件 |
|---|---|
| ディストリ | Ubuntu等（開発時はUbuntu-24.04で確認） |
| Node.js | Codex CLIを動かせるバージョン（nvm経由を推奨。開発時はv22.22.2で確認） |
| Codex CLI | `npm install -g @openai/codex@latest`で**WSL内から**インストールしたもの（詳細は下記トラブルシューティング） |

### Windows側（Windows-nativeモードを使う場合）

| 項目 | 要件 |
|---|---|
| Codex CLI | `npm install -g @openai/codex@latest`で**Windows側から**インストールしたもの（`@openai/codex`が`optionalDependencies`として`codex-win32-x64`／`codex-win32-arm64`を公式配布している）。WSL自体は不要 |

## 新しいPCへの導入手順

### 1. WSL2とディストリの準備

既にWSL2とLinuxディストリ（Ubuntu等）が入っている前提です。未導入なら`wsl --install`でセットアップして
ください。

### 2. WSL内でCodex CLIをインストール

**WSLのターミナル（Windows側のシェルではなく）を開いて**実行します。

```bash
npm install -g @openai/codex@latest
codex --version        # 例: codex-cli 0.144.6
which codex            # 例: /home/<user>/.nvm/versions/node/v22.22.2/bin/codex
codex app-server --help   # 応答が返ればOK
```

`which codex`で表示された**絶対パス**を控えておきます。アプリの初回接続設定で使います。

> Node.jsが入っていない場合は先に[nvm](https://github.com/nvm-sh/nvm)等でWSL内にNode.jsを入れてください。
> Windows側のnpmでインストールしたものは使えません（詳細はトラブルシューティング参照）。

### 3. Windows側の開発ツールを準備

PowerShellで以下を実行します。

```powershell
# Rust（未導入なら https://rustup.rs/ からrustupを入れてから）
rustup update stable
rustc --version    # 1.75以上であること

# Node.js（未導入なら https://nodejs.org/ から。またはwinget/choco等で）
node --version
```

Visual Studio Build Toolsが未導入の場合は、[Visual Studio Installer](https://visualstudio.microsoft.com/downloads/)
から「Build Tools for Visual Studio」を入れ、ワークロード「C++によるデスクトップ開発」を選択してインストール
してください。

### 4. リポジトリを取得してビルド

```powershell
git clone <このリポジトリのURL> WslCodexGui
cd WslCodexGui\app
npm install
```

### 5. 開発モードで起動して動作確認

```powershell
npm run tauri dev
```

初回はRust側のビルドに数十秒〜数分かかります。アプリウィンドウが開いたら、[初回起動時の設定](#初回起動時の設定)
に進んでください。

### 6. 配布用にビルドする場合

このプロジェクトで通常使う直接実行ファイルの再配置は、インストーラーを使わず次のコマンドで行います。

```powershell
npm exec tauri build -- --no-bundle
```

生成物は`app/src-tauri/target/release/app.exe`です。必要な作業が終わったら`app.exe`を終了し、必要なときだけ再度起動してください。

インストーラーを作成して別PCへ配布する場合だけ、次を実行します。

```powershell
npm run tauri build
```

`app/src-tauri/target/release/bundle/` 配下にインストーラ（NSIS `.exe`、MSI `.msi` 等）が生成されます。
これを他のPCへ配って導入することもできますが、**配布先のPCにも上記の動作要件（WSL2 + WSL内Codex CLI +
WebView2）が別途必要**です。アプリ自体はCodexの実行環境を内包しません。

## 開発コマンド

`app/` ディレクトリで実行します。

| コマンド | 内容 |
|---|---|
| `npm run tauri dev` | 開発モードで起動（Vite HMR + Rustホットリビルド） |
| `npm run build` | フロントエンドの型チェック + 本番ビルド（`dist/`） |
| `npm test` | フロントエンドから抽出した純粋ロジックのNodeテスト |
| `npx tsc --noEmit` | フロントエンドの型チェックのみ |
| `npm exec tauri build -- --no-bundle` | インストーラーを作らず直接実行用のリリース`app.exe`をビルド |
| `npm run tauri build` | 配布用インストーラのビルド |
| `cargo build`（`src-tauri/`内） | Rustバックエンドのみビルド |
| `cargo test`（`src-tauri/`内） | Rustバックエンドのunit test |

## 初回起動時の設定

起動直後は接続パネルのみの最小画面が表示されます。以下を入力し、「接続」を押します。

1. **プロバイダ**: OpenAI（既定）または Ollama（ローカル）
2. **接続方式**: 「WSL内のcodex CLI」（既定）または「Windows側のcodex CLI」
   - WSL内を選んだ場合: **WSLディストリ**（`wsl -l -v`で確認できるディストリ名。例: `Ubuntu-24.04`）と
     **codex絶対パス（WSL内）**（上記手順2で控えたパス。例:
     `/home/user/.nvm/versions/node/v22.22.2/bin/codex`）を入力
   - Windows側を選んだ場合: **codex絶対パス（Windows）**（`where codex.cmd`で見つかった絶対パスが自動入力
     される。見つからない場合は手入力）
3. **モデル・推論レベル・速度**（OpenAIプロバイダ時）: 任意。未指定ならサーバー側の設定に従う

接続に成功すると、接続パネルのみの最小画面から通常のフル画面（プロジェクト・スレッド一覧・チャット）に切り
替わります。次に「プロジェクト」欄で作業ディレクトリを選び、「新しいスレッド」でチャットを開始できます。
設定はブラウザのlocalStorageに保存されるため、次回起動時は再入力不要です（ただし起動直後の最小画面表示は
毎回のアプリ起動でリセットされます）。

## トラブルシューティング

開発中に実際に踏んだ問題とその原因・対処です。

### `codex`コマンドが見つからない／`Missing optional dependency @openai/codex-linux-x64`

Windows側でグローバルインストールした`@openai/codex`は、WSLのPATHにも（Windowsパスの引き継ぎ設定により）
紛れ込むことがありますが、Windows用バイナリしか入っていないためWSL上では動作しません。**必ずWSLのターミナル
から**`npm install -g @openai/codex@latest`を実行してください。

### 接続時に絶対パスを要求される

`wsl.exe --exec`はWSLの既定ログインシェルを経由しないため、`.bashrc`/`.profile`のPATH設定（nvm、pyenv等）
が反映されません。相対コマンド名`codex`では見つからないため、本アプリは常に絶対パスを要求する設計です。

### `cargo build`が古いエラーで失敗する／Tauri 2の依存クレートがビルドできない

Rustのバージョンが古い可能性があります。`rustup update stable`で更新してください（1.59.0のような古い版では
ビルドできません）。

### 「⌨ ターミナルを開く」で開いたウィンドウの配色が変

これはアプリの問題ではなく、**Windows Terminal側のプロファイル設定**です。`wsl.exe -d <distro>`起動時、
Windows TerminalはWSL由来の動的プロファイル（`source: "Windows.Terminal.Wsl"`、名前はディストリ名と同じ）
を使います。Store版アプリ由来の似た名前のプロファイル（例: 「Ubuntu 24.04.1 LTS」）と間違えて配色を変更して
いないか確認してください。Windows Terminalの設定は `Ctrl + ,` または `%LOCALAPPDATA%\Packages\Microsoft.
WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json` から編集できます。

### 承認ダイアログが出ない

`ls`や`whoami`のような安全なコマンドは、`approvalPolicy: "untrusted"`でも承認要求なしに実行されることが
あります（PoCで確認済み）。ネットワークアクセスを伴うコマンド等、明確にリスクのある操作でのみ承認要求が
発生します。

### 起動直後だけIMEのON/OFFがおかしい

`App.tsx`のマウント時に、見えない捨て要素へ一瞬フォーカス→ブラーする「IMEウォームアップ」処理が入っている。
これはWebView2の既知の不具合（起動後最初にフォーカスされた要素でIME合成コンテキストが正しく初期化されず、
一度フォーカスを外して戻すと直る）への対症療法。**Windows版Codexアプリ本体でも間欠的に同じ症状が出ており、
直ったように見えてまた再発する質の悪いバグ**なので、この処理を「一見無意味なコード」としてクリーンアップで
消さないこと。消す場合は、起動直後の状態から実際に日本語IMEのON/OFFを試して再発しないか確認してから。

## アーキテクチャ概要

```text
Windows GUI（Tauri Rustバックエンド）
    │ 子プロセスの標準入出力パイプ（ネットワークポート不使用）
    │
    ├─ WSLモード ──▶ wsl.exe -d <distro> --exec <codexの絶対パス> app-server
    │                     │ JSONL（改行区切りJSON）
    │                     ▼
    │                WSL2内の codex app-server（stdio既定モード）
    │
    └─ Windows-nativeモード ──▶ cmd.exe /c <codexの絶対パス> app-server
                                    │ JSONL（改行区切りJSON）
                                    ▼
                               Windows上の codex app-server（stdio既定モード）
```

- 接続方式に関わらず子プロセスの標準入出力パイプで直結し、ネットワークポートは使用しない
- どちらのモードで起動するかは`Connection::spawn`（`src-tauri/src/appserver.rs`）が`connection_mode`引数
  で分岐する。以降のJSON-RPC送受信・リクエストID管理・stdout汚染検出・stdout/stderrの継続的なドレインは
  モードによらず共通のコードが担う
- サーバーからの通知・承認要求はTauriイベント（`codex:notification`、`codex:server-request`等）として
  フロントエンドへ転送される
- フロントエンド（`src/App.tsx`）はプロトコル型（`src/types.ts`、`codex app-server generate-ts`で生成した
  実スキーマを元に手動で必要な型だけ抜粋）に基づいてUIを構築する

詳細な設計判断・検証結果（なぜWebSocketではなくstdio直結を主構成にしたか等）は
[../docs/仕様書.md](../docs/仕様書.md) を参照してください。

## リポジトリ構成

```text
WslCodexGui/
├── docs/
│   ├── 仕様書.md          # 設計仕様書（アーキテクチャ検討・検証記録）
│   └── 残項目.md          # 未対応事項と優先順位
├── poc/
│   ├── phase1-poc.mjs           # 主構成の基本動作PoC
│   ├── phase1b-approval-stop.mjs # 承認フロー・Stop動作のPoC
│   └── phase1c-approval-network.mjs # ネットワークコマンドでの承認要求PoC
└── app/                    # 本体（Tauri 2 + React + TypeScript）
    ├── src/                # フロントエンド（純粋ロジックとNodeテストを含む）
    ├── src-tauri/           # Rustバックエンド
    └── README.md            # このファイル
```
