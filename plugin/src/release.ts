import { GpcApiError } from './client.ts';
import type { CommitOptions, Play } from './edits.ts';
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
  'このアプリはまだ公開していないので、API では下書きまでしか作れません。save_draft で保存してから、Play Console で審査に出してください。';

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

export async function submitForReview(
  { client, edits }: Play,
  request: SubmitForReviewRequest,
): Promise<SubmitForReviewResult> {
  const { packageName, track, userFraction, cancelChangesInReview, notSentForReview } = request;
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
          `${track} に下書きのリリースがありません。下書きのあるトラック: ${elsewhere.join('、')}。track を確かめてください。`,
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
          `段階的公開のリリース ${name ?? '（名前なし）'}（${status}）を、新しいリリースで置き換えます。`,
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
          '審査に出す途中の状態を残さないよう、まだ送っていない変更を捨てました。',
          ...(lost.length === 0 ? [] : [`失われた変更: ${lost.join('、')}。`]),
          'get_release_status で、送られたかを確かめてください。',
        ].join('\n'),
        { cause: error },
      );
    }
    return finished(
      { before: viewOf(draft), after: viewOf(promoted) },
      true,
      [
        ...previous,
        `${track} のリリース（${(draft.versionCodes ?? []).join('・')}）を審査に出した`,
      ],
      warnings,
    );
  });
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
        `まだ送っていない変更があるので、段階的公開を変えられません（一緒に送られてしまいます）。先に submit_for_review か save_draft で送るか、discard_changes で捨ててください。\nまだ送っていない変更: ${edit.previousChanges.join('、')}`,
      );
    }
    const { releases } = await readTrack(client, edit, track);
    const unchanged = (release: Release): SetPhasedReleaseResult => ({
      packageName,
      track,
      before: viewOf(release),
      after: viewOf(release),
    });
    const rollout =
      releases.find(({ status }) => status === 'inProgress') ?? releases.find(isRollout);
    if (rollout === undefined) {
      const completed = releases.find(({ status }) => status === 'completed');
      if (action === 'complete' && completed !== undefined) {
        return unchanged(completed);
      }
      throw new Error(`${track} に、段階的公開を進めているリリースがありません。`);
    }
    if (action === 'update' && rollout.status === 'halted') {
      throw new Error(
        `${track} の段階的公開は止まっています。割合を変えて再開するなら、resume に userFraction を渡してください。`,
      );
    }
    if (action === 'resume' && rollout.userFraction === undefined && userFraction === undefined) {
      throw new Error(
        `${track} の止まっているリリースには、割合がありません（全員向けのリリースを止めたものです）。resume に userFraction を渡すか、complete で全員に出してください。`,
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
      return completed;
    }
  }
}

function checkFraction(action: PhasedReleaseAction, userFraction: number | undefined): void {
  if (action === 'update' && userFraction === undefined) {
    throw new Error('update には、userFraction（0 より大きく 1 より小さい割合）が要ります。');
  }
  if ((action === 'pause' || action === 'complete') && userFraction !== undefined) {
    throw new Error(`${action} には、userFraction を渡せません。`);
  }
}
