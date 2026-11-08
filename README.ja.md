# gpc-mcp

[English](README.md) | 日本語

Google Play Developer API を呼ぶ MCP サーバー（非公式）。Claude Code のプラグインとして入れ、Google Play へのリリース作業を Claude Code に頼めるようにする。

## ツール

| ツール | すること |
| :- | :- |
| `list_apps` | アプリの名前とパッケージ名を返す |
| `get_release_status` | 新しい5つのビルドと、トラックごとのリリースと、リリースごとの審査の状態を返す |
| `get_localizations` | 言語ごとのストアの掲載情報（タイトル・簡単な説明・詳しい説明・動画の URL）と、既定の言語と、トラックのリリースノートを返す |
| `upload_bundle` | App Bundle を、まだ送っていない変更に上げる。同じファイルがあれば上げ直さない |
| `select_build` | トラックの下書きのリリースに、ビルドを選ぶ。下書きが無ければ作る |
| `discard_changes` | まだ Google Play に送っていない変更を捨てる |

## 入れ方

MCP サーバーは、PATH にある Node（24 以上）で動く。

1. Google Cloud のコンソールでプロジェクトを選び、「Google Play Android Developer API」と「Google Play Developer Reporting API」を有効にする。サービスアカウントを作り、JSON 鍵をダウンロードする
2. JSON 鍵を、好きな場所（例: `~/.config/gpc-mcp/service-account.json`）に置き、`chmod 600` で自分だけが読めるようにする
3. Play Console の「ユーザーと権限」で、サービスアカウントのメールアドレスを招待する。アプリごとに、次の権限を与える
   - アプリ情報の閲覧（読み取り専用）
   - 製品版としてのリリース、デバイスの除外、Play アプリ署名の使用
   - テストトラックへのアプリのリリース
   - ストアでの表示の管理
4. Claude Code で、次を打つ

   ```
   /plugin marketplace add iHideck/gpc-mcp
   /plugin install gpc-mcp@gpc-mcp
   ```

5. 設定の画面で、JSON 鍵のパスを入れる。あとから直すときは、`/plugin configure gpc-mcp@gpc-mcp` を打つ

## 開発

プラグインは `plugin/` にある。Claude Code がプラグインと一緒に入れるのは、`plugin/package.json` の依存だけ。ESLint などの開発の道具は、ルートの `package.json` に置く。

| コマンド | すること |
| :- | :- |
| `make setup` | 依存を入れ、Google の API の仕様を落とす |
| `make check` | CI と同じ検査（ESLint・整形・型の検査・テスト）を流す |
| `make download-discovery` | Google がいま配っている API の仕様を、`.local/` に落とし直す |
| `make validate-plugin` | プラグインとマーケットプレイスの設定を検査する |
| `make run-claude` | 手元のソースの MCP サーバーをつないで、Claude Code を起動する |

テストは、送るリクエストのパス・引数・値が、API の仕様にあるかを確かめる。CI は毎回、Google がいま配っている仕様を落として照らす。

手元のソースを本物の API で試すときは、JSON 鍵のパスを環境変数 `GPC_SERVICE_ACCOUNT_KEY` に入れてから、`make run-claude` を打つ。プラグインの設定は、`claude --plugin-dir` で読んだプラグインには渡らない。このとき、書くツールは Google Play を変えず、送るはずだったリクエストをエラーで返す。本当に書いて試すときは、`GPC_READ_ONLY=0` も入れる。
