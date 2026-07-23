# サードパーティ依存関係とライセンス

このアプリ本体は[LICENSE](LICENSE)（MIT）で配布する。本ドキュメントは、MIT採用前に実施した依存関係のライセンス調査（2026-07-23実施、対象コミット `34cf934` 時点）の結果を記録する。

## 調査結果の要約

npm依存（`app/package-lock.json`記載の全パッケージ、200件超）、Cargo依存（`cargo metadata`で取得した全クレート、400件超）のいずれにも、**GPL／AGPL等の強いコピーレフトライセンスは存在しない**。確認されたライセンスは以下の通り、いずれもMITでの配布と両立する。

| 区分 | 確認されたライセンス |
|---|---|
| npm | MIT、Apache-2.0、ISC、BSD-3-Clause、CC-BY-4.0（`caniuse-lite`。ビルド時のみ使用され配布バイナリには含まれない） |
| Cargo | MIT、Apache-2.0（多くはMIT/Apache-2.0のデュアルライセンス）、Unicode-3.0、Zlib、BSD-3-Clause、Unlicense、0BSD、CC0-1.0、MPL-2.0（後述） |

個別に確認した点:

- **`r-efi`**（間接依存、UEFI関連）: `MIT OR Apache-2.0 OR LGPL-2.1-or-later`という3択の選択制ライセンス。MITまたはApache-2.0を選んで従えばよく、LGPLの条件に縛られる必要はない。
- **`cssparser`／`cssparser-macros`／`selectors`／`dtoa-short`／`option-ext`**（間接依存、webview関連、計5クレート）: MPL-2.0（ファイル単位の弱いコピーレフト）。これらのクレート自身のソースを改変しない限り、利用する側（本アプリ）のライセンスには影響しない。本アプリはこれらを改変せずCargo経由で利用しているのみ。

## 未対応（残項目.md 参照）

Apache-2.0・BSD-3-Clause・MPL-2.0など一部のライセンスは、配布物に third-party の著作権表示・ライセンス全文を同梱することを要求する。本ドキュメントはその要件を満たす完全な通知文書ではなく、あくまで調査結果の要約である。配布用インストーラを生成する際（[残項目.md](docs/残項目.md)の未完了項目7）に、`cargo about`や`license-checker`等のツールで全依存関係のライセンス全文を機械的に収集し、正式な third-party notices ファイルとして同梱することを推奨する。
