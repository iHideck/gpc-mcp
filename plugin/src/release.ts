import { GpcApiError } from './client.ts';
import { AppEdit, isGone, type CommitOptions, type Play } from './edits.ts';
import { readReview, type ReviewState } from './release-status.ts';
import {
  isDraft,
  isRollout,
  listTracks,
  readTrack,
  viewOf,
  writeTrack,
  type Release,
  type ReleaseView,
} from './tracks.ts';

export const PHASED_RELEASE_ACTIONS = ['pause', 'resume', 'update', 'complete'] as const;
type PhasedReleaseAction = (typeof PHASED_RELEASE_ACTIONS)[number];

export type SaveDraftRequest = { packageName: string } & CommitOptions;

export type SaveDraftResult = { packageName: string; saved: string[] };

export type SubmitForReviewRequest = {
  packageName: string;
  track: string;
  userFraction?: number | undefined;
  countries?: string[] | undefined;
  includeRestOfWorld?: boolean | undefined;
} & CommitOptions;

export type SubmitForReviewResult = {
  packageName: string;
  track: string;
  submitted: boolean;
  release: { before: ReleaseView; after: ReleaseView } | null;
  sent: string[];
  review: ReviewState[] | null;
  warnings: string[];
};

export type SetPhasedReleaseRequest = {
  packageName: string;
  track: string;
  action: PhasedReleaseAction;
  userFraction?: number | undefined;
} & CommitOptions;

export type SetPhasedReleaseResult = {
  packageName: string;
  track: string;
  before: ReleaseView;
  after: ReleaseView;
};

const DRAFT_APP_HINT =
  'This app has never been published, so the API can only create drafts. Save the changes with save_draft, then send them for review in Play Console.';

export async function saveDraft(
  { edits }: Play,
  { packageName, ...flags }: SaveDraftRequest,
): Promise<SaveDraftResult> {
  return edits.write(packageName, async (edit) => {
    if (edit.previousChanges.length === 0) {
      return { packageName, saved: [] };
    }
    const saved = [...edit.previousChanges];
    await edit.commit(flags);
    return { packageName, saved };
  });
}

export type ValidateChangesResult = {
  packageName: string;
  valid: boolean | null;
  problem: string | null;
  changes: string[];
};

export async function validateChanges(
  { client, edits }: Play,
  packageName: string,
): Promise<ValidateChangesResult> {
  return edits.write(packageName, async (edit) => {
    const changes = [...edit.previousChanges];
    if (changes.length === 0) {
      return { packageName, valid: null, problem: null, changes };
    }
    try {
      await client.post(`${edit.path}:validate`, {}, undefined, AppEdit);
      return { packageName, valid: true, problem: null, changes };
    } catch (error) {
      if (error instanceof GpcApiError && isVerdict(error)) {
        return { packageName, valid: false, problem: error.message, changes };
      }
      throw error;
    }
  });
}

// 鍵・権限・呼び出しの上限の失敗は、変更の中身の問題ではない
function isVerdict(error: GpcApiError): boolean {
  return (
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 429].includes(error.status) &&
    !isGone(error)
  );
}

export async function submitForReview(
  { client, edits }: Play,
  request: SubmitForReviewRequest,
): Promise<SubmitForReviewResult> {
  const {
    packageName,
    track,
    userFraction,
    countries,
    includeRestOfWorld,
    cancelChangesInReview,
    notSentForReview,
  } = request;
  checkCountries(request);
  return edits.write(packageName, async (edit) => {
    const flags = { cancelChangesInReview, notSentForReview };
    const target = await readTrack(client, edit, track);
    const draft = target.releases.find(isDraft);
    const previous = [...edit.previousChanges];
    const finished = async (
      release: SubmitForReviewResult['release'],
      submitted: boolean,
      sent: string[],
      warnings: string[],
    ): Promise<SubmitForReviewResult> => ({
      packageName,
      track,
      submitted,
      release,
      sent,
      // 送り終えたあとなので、状態を読めなくても失敗にしない
      review: (await readReview(client, packageName, track).catch(() => ({ review: null }))).review,
      warnings,
    });
    if (draft === undefined) {
      const elsewhere = (await listTracks(client, edit))
        .filter(({ releases }) => releases.some(isDraft))
        .map(({ track: name }) => name);
      if (elsewhere.length > 0) {
        throw new Error(
          `${track} has no draft release. Tracks with a draft release: ${elsewhere.join(', ')}. Check the track.`,
        );
      }
      if (previous.length === 0) {
        return finished(null, false, [], []);
      }
      await edit.commit(flags);
      return finished(null, true, previous, []);
    }
    const promoted: Release = {
      ...draft,
      status: userFraction === undefined ? 'completed' : 'inProgress',
      ...(userFraction === undefined ? {} : { userFraction }),
      ...(countries === undefined
        ? {}
        : { countryTargeting: { countries, includeRestOfWorld: includeRestOfWorld ?? false } }),
    };
    const others = target.releases.filter((release) => release !== draft);
    // 全員に出すなら、前のリリースはすべて置き換わる。段階的公開なら、全員向けのリリースは残す
    const kept = others.filter(
      (release) => userFraction !== undefined && release.status === 'completed',
    );
    const warnings = others
      .filter((release) => isRollout(release) && !kept.includes(release))
      .map(
        ({ name, status }) =>
          `The staged rollout release ${name ?? '(no name)'} (${status}) is replaced by the new release.`,
      );
    try {
      await writeTrack(client, edit, track, [...kept, promoted]);
      await edit.commit(flags);
    } catch (error) {
      // 審査に出す形のまま edit を残すと、あとの save_draft で全員に出てしまう
      const restored = await writeTrack(client, edit, track, target.releases).then(
        () => true,
        () => false,
      );
      if (restored) {
        throw error instanceof GpcApiError ? withDraftAppHint(error) : error;
      }
      const lost = await edit.abandon();
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          'Discarded the unsent changes so that no half-submitted state is left.',
          ...(lost.length === 0 ? [] : [`Lost changes: ${lost.join(', ')}.`]),
          'Check with get_release_status whether the changes were sent.',
        ].join('\n'),
        { cause: error },
      );
    }
    return finished(
      { before: viewOf(draft), after: viewOf(promoted) },
      true,
      [
        ...previous,
        `Submitted the ${track} release (${(draft.versionCodes ?? []).join(', ')}) for review`,
      ],
      warnings,
    );
  });
}

// Google の仕様では、国を絞れるのは製品版の段階的公開だけ
function checkCountries({
  track,
  userFraction,
  countries,
  includeRestOfWorld,
}: SubmitForReviewRequest): void {
  if (includeRestOfWorld !== undefined && countries === undefined) {
    throw new Error('Pass includeRestOfWorld together with countries.');
  }
  if (countries !== undefined && (userFraction === undefined || !/(^|:)production$/.test(track))) {
    throw new Error(
      'Countries can be targeted only for a staged rollout (with userFraction) on the production track.',
    );
  }
}

function withDraftAppHint(error: GpcApiError): GpcApiError {
  return /draft app/i.test(error.message)
    ? new GpcApiError(error.status, `${DRAFT_APP_HINT}\n${error.message}`, error.reasons)
    : error;
}

export async function setPhasedRelease(
  { client, edits }: Play,
  request: SetPhasedReleaseRequest,
): Promise<SetPhasedReleaseResult> {
  const { packageName, track, action, userFraction, ...flags } = request;
  checkFraction(action, userFraction);
  return edits.write(packageName, async (edit) => {
    if (edit.previousChanges.length > 0) {
      throw new Error(
        `Cannot change the staged rollout while there are unsent changes, because they would be sent with it. First send them with submit_for_review or save_draft, or discard them with discard_changes.\nUnsent changes: ${edit.previousChanges.join(', ')}`,
      );
    }
    const { releases } = await readTrack(client, edit, track);
    const unchanged = (release: Release): SetPhasedReleaseResult => ({
      packageName,
      track,
      before: viewOf(release),
      after: viewOf(release),
    });
    const completed = releases.find(({ status }) => status === 'completed');
    const rollout =
      releases.find(({ status }) => status === 'inProgress') ??
      releases.find(isRollout) ??
      (action === 'pause' ? completed : undefined);
    if (rollout === undefined) {
      if (action === 'complete' && completed !== undefined) {
        return unchanged(completed);
      }
      throw new Error(`${track} has no release in a staged rollout.`);
    }
    if (action === 'update' && rollout.status === 'halted') {
      throw new Error(
        `The staged rollout on ${track} is paused. To resume it with a new percentage, pass userFraction to resume.`,
      );
    }
    if (action === 'resume' && rollout.userFraction === undefined && userFraction === undefined) {
      throw new Error(
        `The paused release on ${track} has no percentage, because it was a release to all users. Pass userFraction to resume, or use complete to release it to all users.`,
      );
    }
    const next = applyAction(rollout, action, userFraction);
    if (next.status === rollout.status && next.userFraction === rollout.userFraction) {
      return unchanged(rollout);
    }
    const others = releases.filter((release) => release !== rollout);
    // 同じ状態のリリースは1つしか持てないので、全員に出すときは、前の全員向けのリリースを外す
    const kept =
      next.status === 'completed' ? others.filter(({ status }) => status !== 'completed') : others;
    await writeTrack(client, edit, track, [...kept, next]);
    await edit.commit(flags);
    return { packageName, track, before: viewOf(rollout), after: viewOf(next) };
  });
}

function applyAction(
  rollout: Release,
  action: PhasedReleaseAction,
  userFraction: number | undefined,
): Release {
  switch (action) {
    case 'pause':
      return { ...rollout, status: 'halted' };
    case 'resume':
    case 'update':
      return {
        ...rollout,
        status: 'inProgress',
        ...(userFraction === undefined ? {} : { userFraction }),
      };
    case 'complete': {
      const completed: Release = { ...rollout, status: 'completed' };
      delete completed.userFraction;
      // Google の仕様では、国の指定は段階的公開のときだけ付けられる
      delete completed.countryTargeting;
      return completed;
    }
  }
}

function checkFraction(action: PhasedReleaseAction, userFraction: number | undefined): void {
  if (action === 'update' && userFraction === undefined) {
    throw new Error('update requires userFraction (a fraction greater than 0 and less than 1).');
  }
  if ((action === 'pause' || action === 'complete') && userFraction !== undefined) {
    throw new Error(`${action} does not take userFraction.`);
  }
}
