import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { setAppInfo } from './app-info.ts';
import { listApps } from './apps.ts';
import { getAvailability } from './availability.ts';
import { createTokenSource, loadCredentials } from './auth.ts';
import { uploadBundle } from './bundles.ts';
import { createClient, isReadOnly } from './client.ts';
import { createPlay } from './edits.ts';
import { once } from './lazy.ts';
import { createFileStore, type PendingStore } from './pending-store.ts';
import { getLocalizations } from './localizations.ts';
import { getReleaseStatus } from './release-status.ts';
import {
  PHASED_RELEASE_ACTIONS,
  saveDraft,
  setPhasedRelease,
  submitForReview,
  validateChanges,
} from './release.ts';
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
    pendingStore(process.env.CLAUDE_PLUGIN_DATA),
  ),
);

// プラグインの外（make run-claude）には保存の場所が無いので、そのセッションの間だけ覚える
function pendingStore(dataDirectory: string | undefined): PendingStore | undefined {
  return dataDirectory === undefined
    ? undefined
    : createFileStore(join(dataDirectory, 'pending-edits.json'));
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const appArguments = {
  packageName: z.string().min(1).describe('アプリのパッケージ名（例: com.ihideck.machosterone）'),
};

const TRACK_DESCRIPTION =
  'トラックの名前。production（製品版）・beta（オープンテスト）・alpha（クローズドテストの既定）・internal（内部テスト）か、Play Console で作ったクローズドテストの名前';

const trackArgument = z.string().min(1).default(DEFAULT_TRACK).describe(TRACK_DESCRIPTION);

// 外に出るツールでは省けない。既定の production に、別のトラックのつもりで出さないため
const requiredTrackArgument = z.string().min(1).describe(TRACK_DESCRIPTION);

const notSentForReviewArgument = z
  .boolean()
  .optional()
  .describe(
    'Google が審査に自動で送れない状態（却下のあとなど）のときに true にする。保存だけして、Play Console の [公開の概要] の [審査に送信] で送る',
  );

const cancelChangesInReviewArgument = z
  .boolean()
  .optional()
  .describe(
    '審査中の変更があるときに、それを取り下げてから送るなら true。省くと、審査中の変更があれば送らない',
  );

const userFractionArgument = z.number().gt(0).lt(1);

// 外に出る操作は、Claude Code が呼ぶたびに、利用者の確認を求める（どの権限のモードでも、許可の決まりでも省けない）
const NEEDS_APPROVAL = { 'anthropic/requiresUserInteraction': true };

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
  'get_availability',
  {
    title: '配信する国',
    description:
      'トラックの配信する国（2文字の国コード）と、その他の国に配信するか（restOfWorld）、製品版と同じ設定か（syncWithProduction）を返す。配信する国は API では変えられないので、変えるときは Play Console で行う。',
    inputSchema: z.object({ ...appArguments, track: trackArgument }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (request) => json(await getAvailability(await getPlay(), request)),
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
  'validate_changes',
  {
    title: 'まだ送っていない変更を確かめる',
    description:
      'まだ送っていない変更（pending）を、Google の検査に通す。Google Play には何も送らない。問題なければ valid が true、問題があれば valid が false で problem に理由を返す。まだ送っていない変更が無ければ valid は null。',
    inputSchema: z.object(appArguments),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ packageName }) => json(await validateChanges(await getPlay(), packageName)),
);

server.registerTool(
  'save_draft',
  {
    title: '下書きのまま保存する',
    description:
      'まだ送っていない変更（pending）を、Google Play に保存する。リリースは下書きのまま残る。公開したことのないアプリは API では審査に出せないので、これで保存してから Play Console で審査に出す。掲載の文と画像の変更は、公開済みのアプリでは、保存すると Google の審査に送られる。審査中の変更があれば送らない。呼ぶたびに、利用者の確認が要る。保存した変更を返す。',
    inputSchema: z.object({
      ...appArguments,
      cancelChangesInReview: cancelChangesInReviewArgument,
      notSentForReview: notSentForReviewArgument,
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await saveDraft(await getPlay(), request)),
);

server.registerTool(
  'submit_for_review',
  {
    title: '審査に出す',
    description:
      'トラックの下書きのリリースと、まだ送っていない変更（掲載の文・画像など）を、Google Play に送る。審査のあるトラックでは審査に出す。内部テスト（internal）は審査なしですぐ配信される。審査が通ると、管理対象の公開を切っていれば自動で公開される。userFraction を渡すと段階的公開にする。省くと全員に出す。下書きが無くても、掲載の文などの変更があれば、それを送る。審査中の変更があれば送らない。呼ぶたびに、利用者の確認が要る。送ったリリースの前と後、送った変更、審査の状態、気を付けること（warnings）を返す。',
    inputSchema: z.object({
      ...appArguments,
      track: requiredTrackArgument,
      userFraction: userFractionArgument
        .optional()
        .describe('段階的公開で配る割合（0 より大きく 1 より小さい。例: 0.2）'),
      countries: z
        .array(z.string().regex(/^[A-Z]{2}$/, '国は JP・US のような2文字のコードです'))
        .min(1)
        .optional()
        .describe('段階的公開を配る国（例: ["JP", "US"]）。製品版の段階的公開だけで使える'),
      includeRestOfWorld: z
        .boolean()
        .optional()
        .describe('countries のほかの国にも配るか。省くと配らない'),
      cancelChangesInReview: cancelChangesInReviewArgument,
      notSentForReview: notSentForReviewArgument,
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await submitForReview(await getPlay(), request)),
);

server.registerTool(
  'set_phased_release',
  {
    title: '段階的公開を変える',
    description:
      '進めている段階的公開を、止める（pause）・再開する（resume）・割合を変える（update）・全員に出す（complete）。全員に出すと、元に戻せない。もうその状態なら、そのまま返す。まだ送っていない変更（pending）があるときは、一緒に送られないように変えない。審査中の変更があれば送らない。呼ぶたびに、利用者の確認が要る。変える前と後を返す。',
    inputSchema: z.object({
      ...appArguments,
      track: requiredTrackArgument,
      action: z
        .enum(PHASED_RELEASE_ACTIONS)
        .describe(
          'pause は止める、resume は再開する（userFraction を渡すと割合も変える）、update は進めている段階的公開の割合を変える（userFraction が要る）、complete は全員に出す',
        ),
      userFraction: userFractionArgument
        .optional()
        .describe('配る割合（0 より大きく 1 より小さい。例: 0.5）'),
      cancelChangesInReview: cancelChangesInReviewArgument,
      notSentForReview: notSentForReviewArgument,
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await setPhasedRelease(await getPlay(), request)),
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
