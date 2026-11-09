import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import {
  saveDraft,
  setPhasedRelease,
  submitForReview,
  validateChanges,
} from '../plugin/src/release.ts';
import { setAppInfo } from '../plugin/src/app-info.ts';
import { selectBuild } from '../plugin/src/select-build.ts';
import { apiError, fakePlay, type FakeRelease } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const COMPLETED: FakeRelease = { name: '1.0.0', status: 'completed', versionCodes: ['1'] };
const DRAFT: FakeRelease = {
  status: 'draft',
  versionCodes: ['2'],
  releaseNotes: [{ language: 'ja-JP', text: '直した' }],
};
const BUNDLES = [1, 2].map((versionCode) => ({
  versionCode,
  sha256: `b${versionCode}`,
  sha1: 'x',
}));
const DETAILS = { defaultLanguage: 'ja-JP', contactEmail: 'me@example.com' };

function setup(options: Parameters<typeof fakePlay>[0] = {}) {
  const fake = fakePlay({
    bundles: BUNDLES,
    details: DETAILS,
    tracks: { production: [COMPLETED, DRAFT] },
    ...options,
  });
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

type Setup = ReturnType<typeof setup>;

function commitSearch(fake: Setup['fake']): URLSearchParams | undefined {
  const call = fake.fetch.mock.calls.find(([input]) => String(input).includes(':commit'));
  return call === undefined ? undefined : new URL(String(call[0])).searchParams;
}

function changeEmail({ play }: Pick<Setup, 'play'>) {
  return setAppInfo(play, { packageName: PACKAGE, contactEmail: 'new@example.com' });
}

const submit = { packageName: PACKAGE, track: 'production' };

describe('saveDraft', () => {
  it('まだ送っていない変更を保存する。審査中の変更があれば止める設定で送る', async () => {
    const { fake, play } = setup();
    await changeEmail({ play });

    const result = await saveDraft(play, { packageName: PACKAGE });

    expect(result.saved).toEqual(['App の情報（contactEmail）を変えた']);
    expect(fake.live.details.contactEmail).toBe('new@example.com');
    expect(commitSearch(fake)?.get('changesInReviewBehavior')).toBe('ERROR_IF_IN_REVIEW');
    expect(commitSearch(fake)?.has('changesNotSentForReview')).toBe(false);
    expect(play.edits.pending(PACKAGE)).toBeNull();
    expect(fake.openEdits()).toEqual([]);
  });

  it('下書きのリリースは、下書きのまま保存する', async () => {
    const { fake, play } = setup({ tracks: { production: [COMPLETED] } });
    await selectBuild(play, { ...submit, versionCode: 2 });

    await saveDraft(play, { packageName: PACKAGE });

    expect(fake.live.tracks.production).toEqual([
      COMPLETED,
      { status: 'draft', versionCodes: ['2'] },
    ]);
  });

  it('何も送っていない変更が無ければ、コミットしない', async () => {
    const { fake, play } = setup();

    expect(await saveDraft(play, { packageName: PACKAGE })).toEqual({
      packageName: PACKAGE,
      saved: [],
    });

    expect(commitSearch(fake)).toBeUndefined();
  });

  it('自動で審査に送れない状態では、notSentForReview を案内し、変更は残す', async () => {
    const { fake, play } = setup({ autoReview: false });
    await changeEmail({ play });

    await expect(saveDraft(play, { packageName: PACKAGE })).rejects.toThrow(
      /notSentForReview: true で保存[\s\S]*changesNotSentForReview to true/,
    );

    expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(1);
    await saveDraft(play, { packageName: PACKAGE, notSentForReview: true });
    expect(fake.live.details.contactEmail).toBe('new@example.com');
  });

  it('自動で審査に送る状態で notSentForReview を渡すと、外すように案内する', async () => {
    const { play } = setup({ autoReview: true });
    await changeEmail({ play });

    await expect(saveDraft(play, { packageName: PACKAGE, notSentForReview: true })).rejects.toThrow(
      'notSentForReview を外してください',
    );
  });

  it('審査中の変更があると、審査を止めず、知らせて変更は残す', async () => {
    const { fake, play } = setup({ inReview: true });
    await changeEmail({ play });

    await expect(saveDraft(play, { packageName: PACKAGE })).rejects.toThrow(
      /審査中の変更があるので、送りませんでした[\s\S]*cancelChangesInReview/,
    );

    expect(fake.live.details.contactEmail).toBe(DETAILS.contactEmail);
    expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(1);
  });
});

describe('validateChanges', () => {
  const VALIDATE = `POST /androidpublisher/v3/applications/${PACKAGE}/edits/edit-1:validate`;

  it('まだ送っていない変更を検査に通し、何も送らず、変更は残す', async () => {
    const { fake, play } = setup();
    await changeEmail({ play });

    const result = await validateChanges(play, PACKAGE);

    expect(result).toEqual({
      packageName: PACKAGE,
      valid: true,
      problem: null,
      changes: ['App の情報（contactEmail）を変えた'],
    });
    expect(fake.live.details.contactEmail).toBe(DETAILS.contactEmail);
    expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(1);
  });

  it('検査で断られたら、理由を返し、変更は残す', async () => {
    const { play } = setup({ failures: { [VALIDATE]: apiError(400, 'Listing is incomplete.') } });
    await changeEmail({ play });

    const result = await validateChanges(play, PACKAGE);

    expect(result.valid).toBe(false);
    expect(result.problem).toContain('Listing is incomplete.');
    expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(1);
  });

  it('変更が無ければ検査しない', async () => {
    const { fake, play } = setup();

    expect(await validateChanges(play, PACKAGE)).toMatchObject({ valid: null, changes: [] });

    expect(fake.requests().some((request) => request.endsWith(':validate'))).toBe(false);
    expect(fake.openEdits()).toEqual([]);
  });

  it('edit が無効になっていたら、断られた扱いにせず、失われた変更を知らせる', async () => {
    const { play } = setup({
      failures: { [VALIDATE]: apiError(400, 'This Edit has been deleted.', 'editDeleted') },
    });
    await changeEmail({ play });

    await expect(validateChanges(play, PACKAGE)).rejects.toThrow('無効になりました');
  });

  it.each([401, 403, 429])('%d は、断られた扱いにしない', async (status) => {
    const { play } = setup({ failures: { [VALIDATE]: apiError(status, 'not a verdict') } });
    await changeEmail({ play });

    await expect(validateChanges(play, PACKAGE)).rejects.toThrow(String(status));
    expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(1);
  });

  it('5xx は、断られた扱いにしない', async () => {
    const { play } = setup({ failures: { [VALIDATE]: apiError(503, 'unavailable') } });
    await changeEmail({ play });

    await expect(validateChanges(play, PACKAGE)).rejects.toThrow('503');
  });
});

describe('saveDraft の審査中の変更', () => {
  it('cancelChangesInReview を渡すと、審査中の変更を取り下げて保存する', async () => {
    const { fake, play } = setup({ inReview: true });
    await changeEmail({ play });

    await saveDraft(play, { packageName: PACKAGE, cancelChangesInReview: true });

    expect(commitSearch(fake)?.get('changesInReviewBehavior')).toBe('CANCEL_IN_REVIEW_AND_SUBMIT');
    expect(fake.live.details.contactEmail).toBe('new@example.com');
  });
});

function failing(fake: Setup['fake'], matches: (url: string, init?: RequestInit) => boolean) {
  const original = fake.fetch.getMockImplementation() as typeof fetch;
  let count = 0;
  fake.fetch.mockImplementation(async (input, init) => {
    if (matches(String(input), init) && count === 0) {
      count += 1;
      throw new TypeError('fetch failed');
    }
    return original(input, init);
  });
}

function respondThenDrop(
  fake: Setup['fake'],
  matches: (url: string, init?: RequestInit) => boolean,
) {
  const original = fake.fetch.getMockImplementation() as typeof fetch;
  let count = 0;
  fake.fetch.mockImplementation(async (input, init) => {
    const response = await original(input, init);
    if (matches(String(input), init) && count === 0) {
      count += 1;
      throw new TypeError('fetch failed');
    }
    return response;
  });
}

describe('submitForReview の途中で通信が切れたとき', () => {
  it('送れなかったら下書きに戻し、あとの save_draft で全員に出さない', async () => {
    const { fake, play } = setup();
    await changeEmail({ play });
    failing(fake, (url) => url.includes(':commit'));

    await expect(submitForReview(play, submit)).rejects.toThrow('届いたかは分かりません');

    const [[id] = []] = fake.openEdits();
    expect(fake.snapshotOf(id ?? '')?.tracks.production).toEqual([COMPLETED, DRAFT]);
    expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(1);

    await saveDraft(play, { packageName: PACKAGE });

    expect(fake.live.tracks.production).toEqual([COMPLETED, DRAFT]);
    expect(fake.live.details.contactEmail).toBe('new@example.com');
  });

  it('送ったのに応答が失われたら、変更を手放し、確かめるように返す', async () => {
    const { fake, play } = setup();
    await changeEmail({ play });
    respondThenDrop(fake, (url) => url.includes(':commit'));

    await expect(submitForReview(play, submit)).rejects.toThrow(
      /捨てました[\s\S]*失われた変更: App の情報[\s\S]*get_release_status/,
    );

    expect(play.edits.pending(PACKAGE)).toBeNull();
    expect(fake.live.tracks.production).toEqual([{ ...DRAFT, status: 'completed' }]);
  });

  it('下書きに戻せなかったら、審査に出す形の edit を手放す', async () => {
    const { fake, play } = setup();
    await changeEmail({ play });
    const original = fake.fetch.getMockImplementation() as typeof fetch;
    let puts = 0;
    fake.fetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes(':commit')) {
        throw new TypeError('fetch failed');
      }
      if (init?.method === 'PUT' && url.endsWith('/tracks/production') && (puts += 1) === 2) {
        throw new TypeError('fetch failed');
      }
      return original(input, init);
    });

    await expect(submitForReview(play, submit)).rejects.toThrow('捨てました');

    expect(play.edits.pending(PACKAGE)).toBeNull();
    expect(fake.live.tracks.production).toEqual([COMPLETED, DRAFT]);
    await expect(saveDraft(play, { packageName: PACKAGE })).resolves.toEqual({
      packageName: PACKAGE,
      saved: [],
    });
    expect(fake.live.tracks.production).toEqual([COMPLETED, DRAFT]);
  });

  it('下書きを変える PUT が届いて応答が失われても、下書きに戻す', async () => {
    const { fake, play } = setup();
    await changeEmail({ play });
    respondThenDrop(fake, (url, init) => init?.method === 'PUT' && url.endsWith('/production'));

    await expect(submitForReview(play, submit)).rejects.toThrow('届いたかは分かりません');

    const [[id] = []] = fake.openEdits();
    expect(fake.snapshotOf(id ?? '')?.tracks.production).toEqual([COMPLETED, DRAFT]);
    expect(commitSearch(fake)).toBeUndefined();
  });
});

describe('submitForReview', () => {
  it('送ったあとは審査中になり、続けて段階的公開を変えようとすると止まる', async () => {
    const { fake, play } = setup();

    await submitForReview(play, { ...submit, userFraction: 0.2 });

    await expect(setPhasedRelease(play, { ...submit, action: 'pause' })).rejects.toThrow(
      '審査中の変更があるので',
    );
    expect(fake.live.tracks.production?.[1]?.status).toBe('inProgress');
  });

  it('下書きを全員向けのリリースにして送り、前のリリースは置き換える', async () => {
    const { fake, play } = setup({
      lifecycle: {
        production: [
          { releaseName: '1.0.1', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW' },
        ],
      },
    });

    const result = await submitForReview(play, submit);

    expect(result.submitted).toBe(true);
    expect(result.release?.before.status).toBe('draft');
    expect(result.release?.after.status).toBe('completed');
    expect(result.sent).toEqual(['production のリリース（2）を審査に出した']);
    expect(result.review).toEqual([{ releaseName: '1.0.1', state: 'IN_REVIEW', versionCodes: [] }]);
    expect(fake.live.tracks.production).toEqual([{ ...DRAFT, status: 'completed' }]);
    expect(play.edits.pending(PACKAGE)).toBeNull();
    expect(fake.openEdits()).toEqual([]);
  });

  it('送り終えたあとに状態を読めなくても、成功を返す', async () => {
    const { fake, play } = setup();
    const original = fake.fetch.getMockImplementation() as typeof fetch;
    fake.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/tracks/production/releases')) {
        throw new TypeError('fetch failed');
      }
      return original(input, init);
    });

    const result = await submitForReview(play, submit);

    expect(result).toMatchObject({ submitted: true, review: null });
    expect(fake.live.tracks.production).toEqual([{ ...DRAFT, status: 'completed' }]);
  });

  it('userFraction を渡すと段階的公開にし、全員向けのリリースは残す', async () => {
    const { fake, play } = setup();

    await submitForReview(play, { ...submit, userFraction: 0.2 });

    expect(fake.live.tracks.production).toEqual([
      COMPLETED,
      { ...DRAFT, status: 'inProgress', userFraction: 0.2 },
    ]);
  });

  it('製品版の段階的公開では、配る国を絞れる', async () => {
    const { fake, play } = setup();

    const result = await submitForReview(play, {
      ...submit,
      userFraction: 0.2,
      countries: ['JP', 'US'],
      includeRestOfWorld: true,
    });

    expect(result.release?.after.countryTargeting).toEqual({
      countries: ['JP', 'US'],
      includeRestOfWorld: true,
    });
    expect(fake.live.tracks.production?.[1]?.countryTargeting).toEqual({
      countries: ['JP', 'US'],
      includeRestOfWorld: true,
    });
  });

  it('その他の国に配るかを省くと、配らない', async () => {
    const { fake, play } = setup();

    await submitForReview(play, { ...submit, userFraction: 0.2, countries: ['JP'] });

    expect(fake.live.tracks.production?.[1]?.countryTargeting).toEqual({
      countries: ['JP'],
      includeRestOfWorld: false,
    });
  });

  it.each([
    ['段階的公開でない', { ...submit, countries: ['JP'] }, '段階的公開'],
    [
      '製品版でない',
      { ...submit, track: 'alpha', userFraction: 0.2, countries: ['JP'] },
      '製品版のトラック',
    ],
    [
      'countries が無いのに includeRestOfWorld を渡す',
      { ...submit, userFraction: 0.2, includeRestOfWorld: true },
      'countries と一緒に',
    ],
  ])('%sときは、何も送らずに断る', async (_, request, message) => {
    const { fake, play } = setup();

    await expect(submitForReview(play, request)).rejects.toThrow(message);

    expect(fake.requests()).toEqual([]);
  });

  it('進めている段階的公開を置き換えるときは、知らせる', async () => {
    const rollout: FakeRelease = {
      name: '1.0.1',
      status: 'inProgress',
      versionCodes: ['1'],
      userFraction: 0.1,
    };
    const { fake, play } = setup({ tracks: { production: [rollout, DRAFT] } });

    const result = await submitForReview(play, submit);

    expect(result.warnings).toEqual([
      '段階的公開のリリース 1.0.1（inProgress）を、新しいリリースで置き換えます。',
    ]);
    expect(fake.live.tracks.production).toEqual([{ ...DRAFT, status: 'completed' }]);
  });

  it('まだ送っていない変更も一緒に送る', async () => {
    const { fake, play } = setup();
    await changeEmail({ play });

    const result = await submitForReview(play, submit);

    expect(result.sent).toEqual([
      'App の情報（contactEmail）を変えた',
      'production のリリース（2）を審査に出した',
    ]);
    expect(fake.live.details.contactEmail).toBe('new@example.com');
  });

  it('下書きが無くても、掲載の文などの変更があれば、それを送る', async () => {
    const { fake, play } = setup({ tracks: { production: [COMPLETED] } });
    await changeEmail({ play });

    const result = await submitForReview(play, submit);

    expect(result).toMatchObject({ submitted: true, release: null });
    expect(fake.live.details.contactEmail).toBe('new@example.com');
  });

  it('下書きも変更も無ければ、何も送らない', async () => {
    const { fake, play } = setup({ tracks: { production: [COMPLETED] } });

    const result = await submitForReview(play, submit);

    expect(result).toMatchObject({ submitted: false, release: null, sent: [] });
    expect(commitSearch(fake)).toBeUndefined();
    expect(fake.openEdits()).toEqual([]);
  });

  it('別のトラックに下書きがあるときは、トラックの間違いを知らせ、何も送らない', async () => {
    const { fake, play } = setup({ tracks: { production: [COMPLETED], alpha: [DRAFT] } });

    await expect(submitForReview(play, submit)).rejects.toThrow(
      'production に下書きのリリースがありません。下書きのあるトラック: alpha',
    );

    expect(commitSearch(fake)).toBeUndefined();
  });

  it('審査中の変更があるときは、下書きに戻して止まり、取り下げを選ぶと送れる', async () => {
    const { fake, play } = setup({ inReview: true });
    await changeEmail({ play });

    await expect(submitForReview(play, submit)).rejects.toThrow(/cancelChangesInReview/);

    const [[id] = []] = fake.openEdits();
    expect(fake.snapshotOf(id ?? '')?.tracks.production).toEqual([COMPLETED, DRAFT]);
    expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(1);

    const result = await submitForReview(play, { ...submit, cancelChangesInReview: true });

    expect(result.submitted).toBe(true);
    expect(commitSearch(fake)?.get('changesInReviewBehavior')).toBe('ERROR_IF_IN_REVIEW');
    expect(fake.fetch.mock.calls.map(([input]) => String(input)).at(-2)).toContain(
      'changesInReviewBehavior=CANCEL_IN_REVIEW_AND_SUBMIT',
    );
    expect(fake.live.tracks.production).toEqual([{ ...DRAFT, status: 'completed' }]);
  });

  it('まだ公開していないアプリでは、save_draft を案内し、下書きに戻す', async () => {
    const { fake, play } = setup({ draftApp: true, tracks: { production: [DRAFT] } });

    await expect(submitForReview(play, submit)).rejects.toThrow(
      /save_draft で保存してから、Play Console で審査に出して[\s\S]*draft app/,
    );

    expect(commitSearch(fake)).toBeUndefined();
    expect(fake.live.tracks.production).toEqual([DRAFT]);
  });
});

describe('setPhasedRelease', () => {
  const ROLLOUT: FakeRelease = {
    name: '1.1.0',
    status: 'inProgress',
    versionCodes: ['2'],
    userFraction: 0.2,
  };
  const request = { packageName: PACKAGE, track: 'production' };
  const withRollout = (extra: Parameters<typeof fakePlay>[0] = {}) =>
    setup({ tracks: { production: [COMPLETED, ROLLOUT] }, ...extra });

  it('pause は止める。割合と全員向けのリリースは残す', async () => {
    const { fake, play } = withRollout();

    const result = await setPhasedRelease(play, { ...request, action: 'pause' });

    expect(result.before.status).toBe('inProgress');
    expect(result.after.status).toBe('halted');
    expect(fake.live.tracks.production).toEqual([COMPLETED, { ...ROLLOUT, status: 'halted' }]);
    expect(commitSearch(fake)?.get('changesInReviewBehavior')).toBe('ERROR_IF_IN_REVIEW');
  });

  it('resume は再開する。割合を渡すと割合も変える', async () => {
    const halted: FakeRelease = { ...ROLLOUT, status: 'halted' };
    const { fake, play } = setup({ tracks: { production: [COMPLETED, halted] } });

    await setPhasedRelease(play, { ...request, action: 'resume', userFraction: 0.5 });

    expect(fake.live.tracks.production).toEqual([
      COMPLETED,
      { ...ROLLOUT, status: 'inProgress', userFraction: 0.5 },
    ]);
  });

  it('update は割合を変える', async () => {
    const { fake, play } = withRollout();

    const result = await setPhasedRelease(play, {
      ...request,
      action: 'update',
      userFraction: 0.5,
    });

    expect(result.after.userFraction).toBe(0.5);
    expect(fake.live.tracks.production?.[1]?.userFraction).toBe(0.5);
  });

  it('止めている段階的公開の update は、勝手に再開せず断る', async () => {
    const halted: FakeRelease = { ...ROLLOUT, status: 'halted' };
    const { fake, play } = setup({ tracks: { production: [COMPLETED, halted] } });

    await expect(
      setPhasedRelease(play, { ...request, action: 'update', userFraction: 0.5 }),
    ).rejects.toThrow('resume に userFraction を渡してください');

    expect(fake.live.tracks.production).toEqual([COMPLETED, halted]);
  });

  it('全員向けを止めたリリースの resume は、割合が無ければ断る', async () => {
    const halted: FakeRelease = { name: '2', status: 'halted', versionCodes: ['2'] };
    const { fake, play } = setup({ tracks: { production: [halted, COMPLETED] } });

    await expect(setPhasedRelease(play, { ...request, action: 'resume' })).rejects.toThrow(
      '割合がありません',
    );
    expect(commitSearch(fake)).toBeUndefined();

    await setPhasedRelease(play, { ...request, action: 'resume', userFraction: 0.3 });

    expect(fake.live.tracks.production).toEqual([
      COMPLETED,
      { ...halted, status: 'inProgress', userFraction: 0.3 },
    ]);
  });

  it('自動で審査に送れない状態では、notSentForReview で変えられる', async () => {
    const { fake, play } = withRollout({ autoReview: false });

    await expect(setPhasedRelease(play, { ...request, action: 'pause' })).rejects.toThrow(
      'notSentForReview: true',
    );

    await setPhasedRelease(play, { ...request, action: 'pause', notSentForReview: true });

    expect(fake.live.tracks.production?.[1]?.status).toBe('halted');
  });

  it('update に割合が無ければ断る', async () => {
    const { fake, play } = withRollout();

    await expect(setPhasedRelease(play, { ...request, action: 'update' })).rejects.toThrow(
      'update には、userFraction',
    );

    expect(fake.requests()).toEqual([]);
  });

  it.each(['pause', 'complete'] as const)('%s に割合を渡すと断る', async (action) => {
    const { play } = withRollout();

    await expect(setPhasedRelease(play, { ...request, action, userFraction: 0.5 })).rejects.toThrow(
      'userFraction を渡せません',
    );
  });

  it('complete は全員に出し、割合を外して、前の全員向けのリリースと置き換える', async () => {
    const { fake, play } = withRollout();

    const result = await setPhasedRelease(play, { ...request, action: 'complete' });

    expect(result.after).toMatchObject({ status: 'completed', userFraction: null });
    expect(fake.live.tracks.production).toEqual([
      { name: '1.1.0', status: 'completed', versionCodes: ['2'] },
    ]);
  });

  it('下書きのリリースは、全員に出しても残す', async () => {
    const { fake, play } = setup({ tracks: { production: [COMPLETED, ROLLOUT, DRAFT] } });

    await setPhasedRelease(play, { ...request, action: 'complete' });

    expect(fake.live.tracks.production).toEqual([
      DRAFT,
      { name: '1.1.0', status: 'completed', versionCodes: ['2'] },
    ]);
  });

  it('もうその状態なら、何も送らない', async () => {
    const { fake, play } = setup({
      tracks: { production: [COMPLETED, { ...ROLLOUT, status: 'halted' }] },
    });

    const result = await setPhasedRelease(play, { ...request, action: 'pause' });

    expect(result.before).toEqual(result.after);
    expect(commitSearch(fake)).toBeUndefined();
    expect(fake.openEdits()).toEqual([]);
  });

  it('全員に出し終えたあとの complete は、そのまま返す', async () => {
    const { fake, play } = setup({ tracks: { production: [COMPLETED] } });

    const result = await setPhasedRelease(play, { ...request, action: 'complete' });

    expect(result.after.status).toBe('completed');
    expect(commitSearch(fake)).toBeUndefined();
  });

  it('段階的公開が無ければ、そう返す', async () => {
    const { play } = setup({ tracks: { production: [COMPLETED] } });

    await expect(setPhasedRelease(play, { ...request, action: 'pause' })).rejects.toThrow(
      '段階的公開を進めているリリースがありません',
    );
  });

  it('まだ送っていない変更があるときは、一緒に送らないように断る', async () => {
    const { fake, play } = withRollout();
    await changeEmail({ play });

    await expect(setPhasedRelease(play, { ...request, action: 'pause' })).rejects.toThrow(
      /まだ送っていない変更があるので[\s\S]*App の情報/,
    );

    expect(commitSearch(fake)).toBeUndefined();
    expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(1);
  });

  it('審査中の変更があると止まり、取り下げを選ぶと変えられる', async () => {
    const { fake, play } = withRollout({ inReview: true });

    await expect(setPhasedRelease(play, { ...request, action: 'pause' })).rejects.toThrow(
      'cancelChangesInReview',
    );

    expect(fake.live.tracks.production?.[1]?.status).toBe('inProgress');
    expect(fake.openEdits()).toEqual([]);

    await setPhasedRelease(play, { ...request, action: 'pause', cancelChangesInReview: true });

    expect(fake.live.tracks.production?.[1]?.status).toBe('halted');
  });
});
