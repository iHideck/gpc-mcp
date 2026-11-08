import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import packageJson from '../package.json' with { type: 'json' };
import { listApps } from './apps.ts';
import { createTokenSource, loadCredentials } from './auth.ts';
import { createClient, type GpcClient } from './client.ts';

let client: GpcClient | undefined;

// 鍵は、ツールが初めて呼ばれたときに読む。鍵のファイルを置く前でもサーバーは起動し、ツールが置き場所を返す
async function getClient(): Promise<GpcClient> {
  client ??= createClient(createTokenSource(await loadCredentials(process.env)));
  return client;
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: 'gpc-mcp', version: packageJson.version });

server.registerTool(
  'list_apps',
  {
    title: 'アプリの一覧',
    description: 'Google Play Console にあるアプリの、名前とパッケージ名を返す。',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => json({ apps: await listApps(await getClient()) }),
);

await server.connect(new StdioServerTransport());
