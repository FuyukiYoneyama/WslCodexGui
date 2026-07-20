# WSL Codex GUI

WSL2内で動く [Codex CLI](https://github.com/openai/codex) の `app-server` を、Windowsネイティブの
GUI（Tauri 2 + React）から操作するためのラッパーアプリです。Codexの実行環境（設定・認証・ツールチェーン・
プロジェクトファイル）はすべてWSL側に置き、Windows側は表示と入力に専念します。ネットワークポートは一切
使いません（`wsl.exe`の子プロセスを標準入出力パイプで直結する方式）。

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
- **スレッド管理**: 一覧表示・再開（`thread/resume`）・インライン名前変更（`thread/name/set`）。未接続時に
  スレッドを選ぶと「接続しますか？」の確認ダイアログを出してから接続
- **プロジェクト選択**: Windowsのフォルダ選択ダイアログから`\\wsl.localhost\<distro>\...`を選択し、
  WSLパスへ変換して登録。スレッドを開くとそのスレッド自身の`cwd`に追従
- **承認UI**: `item/commandExecution/requestApproval`等のリクエストに含まれる`availableDecisions`
  配列から、そのリクエストで実際に有効な選択肢だけを動的にボタン化
- **Stop**: `turn/interrupt`のみを送信し、app-serverプロセス自体は終了しない
- **「/」コマンド補完**: `/new` `/goal <text>` `/compact` `/diff` `/status` `/copy` `/model` `/stop`
  `/usage` `/help`。↑↓で選択、Tab/Enterで実行、Escで閉じる
- **使用量バッジ**: 接続時・ターン完了ごとに`account/rateLimits/read`を自動取得し、フッターに残量%を常時表示
  （Codex公式アカウント画面と同じ「残り○%」表記）
- **WSLターミナル / エクスプローラーを開く**: 選択中のWSLパスに対してワンクリックで起動
- **ドラッグ&ドロップ**: エクスプローラーからファイルをコンポーザーにドロップすると、Windowsパスを自動で
  WSLパス（`/home/...`）に変換して挿入。選択中とは別のWSLディストリのUNCパスは拒否
- **画像貼り付け**: クリップボード画像を`Ctrl+V`で添付。保存中は送信を待たせ、接続・ディストリ・スレッドを
  またぐ誤添付を防止。WSL側の一時画像は取り消し・turn完了・切断時に削除
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

### WSL側

| 項目 | 要件 |
|---|---|
| ディストリ | Ubuntu等（開発時はUbuntu-24.04で確認） |
| Node.js | Codex CLIを動かせるバージョン（nvm経由を推奨。開発時はv22.22.2で確認） |
| Codex CLI | `npm install -g @openai/codex@latest`で**WSL内から**インストールしたもの（詳細は下記トラブルシューティング） |

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
| `npm run tauri build` | 配布用インストーラのビルド |
| `cargo build`（`src-tauri/`内） | Rustバックエンドのみビルド |
| `cargo test`（`src-tauri/`内） | Rustバックエンドのunit test |

## 初回起動時の設定

アプリ下部の「接続」欄に以下を入力し、「接続」を押します。

1. **WSLディストリ**: `wsl -l -v`で確認できるディストリ名（例: `Ubuntu-24.04`）
2. **codex絶対パス（WSL内）**: 上記手順2で控えたパス（例: `/home/user/.nvm/versions/node/v22.22.2/bin/codex`）

接続に成功すると入力欄は隠れ、「切断」ボタンだけが残ります。次に「プロジェクト」欄でWSL内の作業ディレクトリを
選び、「新しいスレッド」でチャットを開始できます。設定はブラウザのlocalStorageに保存されるため、次回起動時は
再入力不要です。

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
    ▼
wsl.exe -d <distro> --exec <codexの絶対パス> app-server
    │ JSONL（改行区切りJSON）
    ▼
WSL2内の codex app-server（stdio既定モード）
```

- 通信はRust側（`src-tauri/src/appserver.rs`）が担い、JSONLの送受信・リクエストID管理・stdout汚染検出・
  stdout/stderrの継続的なドレインを行う
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
