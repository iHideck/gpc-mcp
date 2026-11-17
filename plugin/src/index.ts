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
import { setDataSafety } from './data-safety.ts';
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
import { getTesters, setTesters } from './testers.ts';
import { createTrack, DEFAULT_TRACK } from './tracks.ts';

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
    : createFileStore(join(dataDirectory, 'pending-edits'));
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const appArguments = {
  packageName: z.string().min(1).describe('Package name of the app, for example com.example.myapp'),
};

const TRACK_DESCRIPTION =
  'Track name: production, beta (open testing), alpha (the default closed testing track), internal (internal testing), or the name of a closed testing track created in Play Console';

const trackArgument = z.string().min(1).default(DEFAULT_TRACK).describe(TRACK_DESCRIPTION);

// 外に出るツールでは省けない。既定の production に、別のトラックのつもりで出さないため
const requiredTrackArgument = z.string().min(1).describe(TRACK_DESCRIPTION);

const notSentForReviewArgument = z
  .boolean()
  .optional()
  .describe(
    'Set to true when Google cannot send the changes for review automatically, for example after a rejection. The changes are only saved; send them with Send for review on the Publishing overview page in Play Console',
  );

const cancelChangesInReviewArgument = z
  .boolean()
  .optional()
  .describe(
    'Set to true to withdraw changes that are in review, then send. If omitted, nothing is sent while changes are in review',
  );

const userFractionArgument = z.number().gt(0).lt(1);

// 外に出る操作は、Claude Code が呼ぶたびに、利用者の確認を求める（どの権限のモードでも、許可の決まりでも省けない）
const NEEDS_APPROVAL = { 'anthropic/requiresUserInteraction': true };

const server = new McpServer({ name: 'gpc-mcp', version: packageJson.version });

server.registerTool(
  'list_apps',
  {
    title: 'List apps',
    description:
      'Returns the name and package name of each app in Google Play Console. The list is empty unless the service account has permissions for the apps under Users and permissions in Play Console.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => json({ apps: await listApps((await getPlay()).client) }),
);

server.registerTool(
  'get_release_status',
  {
    title: 'Get release status',
    description:
      'Returns the five newest builds, the releases on each track that has releases (name, status, builds, and staged rollout percentage), and the review state (review, or null if it cannot be read). If there are unsent changes (pending), the result includes them.',
    inputSchema: z.object(appArguments),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ packageName }) => json(await getReleaseStatus(await getPlay(), packageName)),
);

server.registerTool(
  'get_localizations',
  {
    title: 'Get store listings',
    description:
      'Returns the store listing text for each language (title, short description, full description, and video URL), the default language, and the release notes of the track (from the draft release if there is one, otherwise from the newest release). If there are many languages and the output is large, narrow it with locales.',
    inputSchema: z.object({
      ...appArguments,
      track: trackArgument,
      locales: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          'Languages to read, for example ["en-US", "ja-JP"]. If omitted, all languages are read',
        ),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (request) => json(await getLocalizations(await getPlay(), request)),
);

server.registerTool(
  'get_availability',
  {
    title: 'Get availability',
    description:
      'Returns the countries where the track is available (two-letter country codes), whether it is available in the rest of the world (restOfWorld), and whether it uses the same settings as production (syncWithProduction). The API cannot change countries; change them in Play Console.',
    inputSchema: z.object({ ...appArguments, track: trackArgument }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (request) => json(await getAvailability(await getPlay(), request)),
);

server.registerTool(
  'create_track',
  {
    title: 'Create closed testing track',
    description:
      'Creates a closed testing track. Does nothing if the track exists. Writes to the unsent changes only; Google Play receives nothing until submit_for_review or save_draft runs. Returns whether the track was created (created).',
    inputSchema: z.object({
      ...appArguments,
      track: z
        .string()
        .min(1)
        .describe(
          'Name of the new track. Start Wear OS and Automotive OS track names with wear: and automotive:',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await createTrack(await getPlay(), request)),
);

server.registerTool(
  'get_testers',
  {
    title: 'Get testers',
    description:
      'Returns the Google Groups of testers for a testing track. The API cannot read email lists added in Play Console.',
    inputSchema: z.object({ ...appArguments, track: requiredTrackArgument }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (request) => json(await getTesters(await getPlay(), request)),
);

server.registerTool(
  'set_testers',
  {
    title: 'Set testers',
    description:
      'Replaces the Google Groups of testers for a testing track with the ones you pass. The API cannot change email lists. Writes to the unsent changes only; Google Play receives nothing until submit_for_review or save_draft runs. Returns the groups before and after.',
    inputSchema: z.object({
      ...appArguments,
      track: requiredTrackArgument,
      googleGroups: z
        .array(z.email())
        .describe(
          'Email addresses of the tester Google Groups. Pass an empty array to remove all of them',
        ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (request) => json(await setTesters(await getPlay(), request)),
);

server.registerTool(
  'upload_bundle',
  {
    title: 'Upload App Bundle',
    description:
      'Uploads an App Bundle (.aab) to the unsent changes. Does not upload it again if the same file (same SHA-256) is already there. The API cannot upload the first build of an app; upload it in Play Console. Returns the versionCode of the build and the unsent changes (pending).',
    inputSchema: z.object({
      ...appArguments,
      file: z.string().min(1).describe('Absolute path of the App Bundle file'),
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
    title: 'Select build',
    description:
      'Selects a build for the draft release on the track. Creates the draft release if there is none. If the release name is omitted, Google names it from the build version. Does not change live releases. Writes to the unsent changes only; Google Play receives nothing until submit_for_review or save_draft runs. Returns the draft before and after, and the unsent changes (pending).',
    inputSchema: z.object({
      ...appArguments,
      track: trackArgument,
      versionCode: z.number().int().positive().describe('versionCode of the build, for example 12'),
      releaseName: z
        .string()
        .min(1)
        .optional()
        .describe('Release name, for example 1.0.2. If omitted, Google names the draft'),
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
    title: 'Set store listings',
    description:
      'Sets the store listing (title, short description, full description, and video URL) and the release notes of the draft release on the track, for each language. Changes only the fields you pass. Checks character limits and URL formats first, and changes nothing if any check fails. For a language with no store listing, creates one when you pass the title, short description, and full description. Writes to the unsent changes only; Google Play receives nothing until submit_for_review or save_draft runs. Returns each changed field before and after, and warnings.',
    inputSchema: z.object({
      ...appArguments,
      track: trackArgument,
      localizations: z
        .array(localizationInput)
        .min(1)
        .describe('Text for each language. Fields you omit are not changed'),
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
    title: 'Replace screenshots',
    description:
      'Replaces the images of one type (imageType) for one language with the files you pass, in the order you pass them. Handles screenshots, the app icon, the feature graphic, and the TV banner. Checks first that every file is a PNG or JPEG and meets the size requirements, and changes nothing if any check fails. Does nothing if the same images (same SHA-256) are already there in the same order. Writes to the unsent changes only; Google Play receives nothing until submit_for_review or save_draft runs. Returns the images before and after, and warnings.',
    inputSchema: z.object({
      ...appArguments,
      locale: z.string().min(1).describe('Language of the images, for example en-US'),
      imageType: z.enum(IMAGE_TYPE_NAMES).describe(
        `Type of images to replace: ${Object.entries(IMAGE_TYPES)
          .map(([name, { label }]) => `${name} (${label})`)
          .join(', ')}`,
      ),
      files: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_IMAGE_FILES)
        .describe('Absolute paths of the image files (PNG or JPEG), in display order'),
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
    title: 'Set app details',
    description:
      'Sets the contact details shown in the store (email, phone, and website) and the default language. Changes only the fields you pass. Writes to the unsent changes only; Google Play receives nothing until submit_for_review or save_draft runs. With sameAsApp, copies the contact details from another app. The API has no category or content rating; set them in Play Console. Returns the details before and after, and the fields missing in the source app (missingInSource).',
    inputSchema: z.object({
      ...appArguments,
      defaultLanguage: z.string().min(1).optional().describe('Default language, for example en-US'),
      contactEmail: z.email().optional().describe('Contact email shown in the store'),
      contactPhone: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Contact phone shown in the store. Pass null or an empty string to remove it. Omit to leave it unchanged',
        ),
      contactWebsite: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Contact website shown in the store. Pass null or an empty string to remove it. Omit to leave it unchanged',
        ),
      sameAsApp: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Package name of the app to copy the contact details (email, phone, and website) from. Fields you pass take precedence over the copied ones. Cannot be used while there are unsent changes',
        ),
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
  'set_data_safety',
  {
    title: 'Set Data safety',
    description:
      'Writes the Data safety declaration from a CSV file in the format that the Data safety page in Play Console exports. This does not go to the unsent changes; Google Play receives it immediately. Overwrites the declaration. Each call requires user confirmation.',
    inputSchema: z.object({
      ...appArguments,
      file: z.string().min(1).describe('Absolute path of the CSV file'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: NEEDS_APPROVAL,
  },
  async (request) => json(await setDataSafety(await getPlay(), request)),
);

server.registerTool(
  'validate_changes',
  {
    title: 'Validate unsent changes',
    description:
      'Runs the unsent changes (pending) through Google checks. Sends nothing to Google Play. Returns valid: true if there are no problems, or valid: false with the reason in problem. valid is null if there are no unsent changes.',
    inputSchema: z.object(appArguments),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ packageName }) => json(await validateChanges(await getPlay(), packageName)),
);

server.registerTool(
  'save_draft',
  {
    title: 'Save draft',
    description:
      'Saves the unsent changes (pending) to Google Play and keeps releases as drafts. The API cannot send an app that has never been published for review, so save with this tool, then send it for review in Play Console. For a published app, saved store listing and image changes are sent to Google for review. Sends nothing while changes are in review. Each call requires user confirmation. Returns the saved changes.',
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
    title: 'Submit for review',
    description:
      'Sends the draft release on the track and the unsent changes (store listings, images, and so on) to Google Play. On tracks with review, submits them for review. The internal track has no review and is available right away. After approval, the release is published automatically unless managed publishing is on. With userFraction, starts a staged rollout; without it, releases to all users. If there is no draft release, sends other unsent changes such as store listings. Sends nothing while changes are in review. Each call requires user confirmation. Returns the release before and after, the sent changes, the review state, and warnings.',
    inputSchema: z.object({
      ...appArguments,
      track: requiredTrackArgument,
      userFraction: userFractionArgument
        .optional()
        .describe(
          'Fraction of users for a staged rollout, greater than 0 and less than 1, for example 0.2',
        ),
      countries: z
        .array(z.string().regex(/^[A-Z]{2}$/, 'Use two-letter country codes such as US or JP'))
        .min(1)
        .optional()
        .describe(
          'Countries for the staged rollout, for example ["US", "JP"]. Only for a staged rollout on the production track',
        ),
      includeRestOfWorld: z
        .boolean()
        .optional()
        .describe('Whether to also release to countries not in countries. If omitted, it does not'),
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
    title: 'Change staged rollout',
    description:
      'Pauses (pause), resumes (resume), changes the percentage of (update), or completes (complete) a staged rollout. With no staged rollout, pause halts the release to all users: new installs and updates get the previous release to all users, and users who already installed it keep it (Google rejects this if there is no previous release). Completing cannot be undone. If the release is already in the requested state, returns it unchanged. Does nothing while there are unsent changes (pending), so that they are not sent with it. Sends nothing while changes are in review. Each call requires user confirmation. Returns the release before and after.',
    inputSchema: z.object({
      ...appArguments,
      track: requiredTrackArgument,
      action: z
        .enum(PHASED_RELEASE_ACTIONS)
        .describe(
          'pause halts the rollout. resume restarts it (with userFraction, also changes the percentage). update changes the percentage of the active rollout (requires userFraction). complete releases to all users',
        ),
      userFraction: userFractionArgument
        .optional()
        .describe('Fraction of users, greater than 0 and less than 1, for example 0.5'),
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
    title: 'Discard unsent changes',
    description:
      'Discards all changes not yet sent to Google Play (pending), including uploaded App Bundles. Returns the discarded changes, or null if there were none.',
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
