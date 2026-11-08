import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { listApps } from './apps.ts';
import { createTokenSource, loadCredentials } from './auth.ts';
import { createClient } from './client.ts';
import { createPlay, type Play } from './edits.ts';
import { getLocalizations } from './localizations.ts';
import { getReleaseStatus } from './release-status.ts';
import { DEFAULT_TRACK } from './tracks.ts';

let play: Play | undefined;

// 鍵は、ツールが初めて呼ばれたときに読む。鍵のファイルを置く前でもサーバーは起動し、ツールが置き場所を返す
async function getPlay(): Promise<Play> {
  play ??= createPlay(createClient(createTokenSource(await loadCredentials(process.env))));
  return play;
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const appArguments = {
  packageName: z.string().min(1).describe('アプリのパッケージ名（例: com.ihideck.machosterone）'),
};

const trackArgument = z
  .string()
  .min(1)
  .default(DEFAULT_TRACK)
  .describe(
    'トラックの名前。production（製品版）・beta（オープンテスト）・alpha（クローズドテストの既定）・internal（内部テスト）か、Play Console で作ったクローズドテストの名前',
  );

const server = new McpServer({ name: 'gpc-mcp', version: packageJson.version });

server.registerTool(
  'list_apps',
  {
    title: 'アプリの一覧',
    description: 'Google Play Console にあるアプリの、名前とパッケージ名を返す。',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => json({ apps: await listApps((await getPlay()).client) }),
);

server.registerTool(
  'get_release_status',
  {
    title: 'リリースの状態',
    description:
      '新しい順に5つのビルドと、リリースのあるトラックごとのリリース（名前・状態・ビルド・段階的公開の割合）と審査の状態（review。読めなければ null）を返す。',
    inputSchema: z.object(appArguments),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ packageName }) => json(await getReleaseStatus(await getPlay(), packageName)),
);

server.registerTool(
  'get_localizations',
  {
    title: '掲載の文',
    description:
      'ストアの掲載情報の、言語ごとの文（タイトル・簡単な説明・詳しい説明・動画の URL）と、既定の言語と、トラックのリリースノート（下書きのリリースがあればそれ、なければ新しいリリース）を返す。言語が多くて出力が大きいときは、locales で絞る。',
    inputSchema: z.object({
      ...appArguments,
      track: trackArgument,
      locales: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('読む言語（例: ["ja-JP", "en-US"]）。省くと、すべての言語を読む'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (request) => json(await getLocalizations(await getPlay(), request)),
);

await server.connect(new StdioServerTransport());
