# gpc-mcp

[English](README.md) | 日本語

Google Play Developer API を呼ぶ MCP サーバー（非公式）。Claude Code のプラグインとして入れ、Google Play へのリリース作業を Claude Code に頼めるようにする。

## ツール

| ツール | すること |
| :- | :- |
| `list_apps` | アプリの名前とパッケージ名を返す |

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
| `make setup` | 依存を入れる |
| `make check` | CI と同じ検査（ESLint・整形・型の検査・テスト）を流す |
| `make validate-plugin` | プラグインとマーケットプレイスの設定を検査する |
