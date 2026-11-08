import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { setAppInfo } from './app-info.ts';
import { listApps } from './apps.ts';
import { createTokenSource, loadCredentials } from './auth.ts';
import { uploadBundle } from './bundles.ts';
import { createClient, isReadOnly } from './client.ts';
import { createPlay } from './edits.ts';
import { once } from './lazy.ts';
import { getLocalizations } from './localizations.ts';
import { getReleaseStatus } from './release-status.ts';
import {
  IMAGE_TYPE_NAMES,
  IMAGE_TYPES,
  MAX_IMAGE_FILES,
  replaceScreenshots,
} from './screenshots.ts';
import { selectBuild } from './select-build.ts';
import { localizationInput, setLocalizations } from './set-localizations.ts';
import { DEFAULT_TRACK } from './tracks.ts';

// 鍵は、ツールが初めて呼ばれたときに読む。鍵のファイルを置く前でもサーバーは起動し、ツールが置き場所を返す
const getPlay = once(async () =>
  createPlay(
    createClient(
      createTokenSource(await loadCredentials(process.env)),
      fetch,
      isReadOnly(process.env.GPC_READ_ONLY),
    ),
  ),
);

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
      '新しい順に5つのビルドと、リリースのあるトラックごとのリリース（名前・状態・ビルド・段階的公開の割合）と審査の状態（review。読めなければ null）を返す。まだ送っていない変更（pending）があれば、それも入った状態を返す。',
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

server.registerTool(
  'upload_bundle',
  {
    title: 'App Bundle を上げる',
    description:
      'App Bundle（.aab）を、まだ送っていない変更に上げる。同じファイル（SHA-256 が同じもの）がもうあれば、上げ直さない。アプリの最初のビルドは、API では上げられないので Play Console で上げる。上げたビルドの versionCode と、まだ送っていない変更（pending）を返す。',
    inputSchema: z.object({
      ...appArguments,
      file: z.string().min(1).describe('App Bundle のファイルの絶対パス'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await uploadBundle(await getPlay(), request)),
);

server.registerTool(
  'select_build',
  {
    title: 'ビルドを選ぶ',
    description:
      'トラックの下書きのリリースに、ビルドを選ぶ。下書きが無ければ作る。リリースの名前は、省くと Google がビルドの版から付ける。公開中のリリースは変えない。まだ送っていない変更に入れるだけで、submit_for_review か save_draft を呼ぶまで Google Play には反映されない。選ぶ前と後の下書きと、まだ送っていない変更（pending）を返す。',
    inputSchema: z.object({
      ...appArguments,
      track: trackArgument,
      versionCode: z.number().int().positive().describe('ビルドの versionCode（例: 12）'),
      releaseName: z
        .string()
        .min(1)
        .optional()
        .describe('リリースの名前（例: 1.0.2）。省くと、下書きの名前を Google に任せる'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await selectBuild(await getPlay(), request)),
);

server.registerTool(
  'set_localizations',
  {
    title: '掲載の文を入れる',
    description:
      'ストアの掲載情報（タイトル・簡単な説明・詳しい説明・動画の URL）と、トラックの下書きのリリースのリリースノートを、言語ごとに入れる。渡した項目だけを変える。入れる前に上限の文字数と URL の形を確かめ、1つでも合わなければ何も変えない。掲載情報が無い言語は、タイトル・簡単な説明・詳しい説明を全部渡すと新しく作る。まだ送っていない変更に入れるだけで、submit_for_review か save_draft を呼ぶまで Google Play には反映されない。変えた項目の前と後と、気を付けること（warnings）を返す。',
    inputSchema: z.object({
      ...appArguments,
      track: trackArgument,
      localizations: z
        .array(localizationInput)
        .min(1)
        .describe('言語ごとの文。渡さない項目は変えない'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await setLocalizations(await getPlay(), request)),
);

server.registerTool(
  'replace_screenshots',
  {
    title: '画面写真を入れ替える',
    description:
      '1つの言語の1つの種類（imageType）の画像を、渡したファイルに入れ替え、渡した順に並べる。画面写真のほか、アイコン・フィーチャーグラフィック・TV のバナーも入れられる。送る前に、全部のファイルが PNG か JPEG かと、大きさが規格に合うかを確かめ、1つでも合わなければ何も変えない。同じ画像（SHA-256 が同じもの）が同じ順で入っていれば、何もしない。まだ送っていない変更に入れるだけで、submit_for_review か save_draft を呼ぶまで Google Play には反映されない。入れ替える前と後の画像の一覧と、気を付けること（warnings）を返す。',
    inputSchema: z.object({
      ...appArguments,
      locale: z.string().min(1).describe('画像を入れ替える言語（例: ja-JP）'),
      imageType: z.enum(IMAGE_TYPE_NAMES).describe(
        `入れ替える画像の種類: ${Object.entries(IMAGE_TYPES)
          .map(([name, { label }]) => `${name}（${label}）`)
          .join('。')}`,
      ),
      files: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_IMAGE_FILES)
        .describe('入れる画像（PNG か JPEG）のファイルの絶対パス。並べたい順に渡す'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await replaceScreenshots(await getPlay(), request)),
);

server.registerTool(
  'set_app_info',
  {
    title: 'App の情報を入れる',
    description:
      'ストアに出す連絡先（メール・電話・ウェブサイト）と、既定の言語を入れる。渡した項目だけを変える。まだ送っていない変更に入れるだけで、submit_for_review か save_draft を呼ぶまで Google Play には反映されない。カテゴリ・コンテンツのレーティング・データセーフティは API に無いので、Play Console で入れる。変える前と後を返す。',
    inputSchema: z.object({
      ...appArguments,
      defaultLanguage: z.string().min(1).optional().describe('既定の言語（例: ja-JP）'),
      contactEmail: z.email().optional().describe('ストアに出すメールアドレス'),
      contactPhone: z
        .string()
        .nullable()
        .optional()
        .describe('ストアに出す電話番号。null か空の文字にすると消す。省くと変えない'),
      contactWebsite: z
        .string()
        .nullable()
        .optional()
        .describe('ストアに出すウェブサイト。null か空の文字にすると消す。省くと変えない'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await setAppInfo(await getPlay(), request)),
);

server.registerTool(
  'discard_changes',
  {
    title: 'まだ送っていない変更を捨てる',
    description:
      'まだ Google Play に送っていない変更（pending）を、すべて捨てる。上げた App Bundle も捨てられる。捨てた変更を返す。何も無ければ null を返す。',
    inputSchema: z.object(appArguments),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ packageName }) =>
    json({ packageName, discarded: await (await getPlay()).edits.discard(packageName) }),
);

await server.connect(new StdioServerTransport());
