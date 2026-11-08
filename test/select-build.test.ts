import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { selectBuild } from '../plugin/src/select-build.ts';
import { fakePlay, type FakeRelease } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const COMPLETED: FakeRelease = {
  name: '1.0.0',
  status: 'completed',
  versionCodes: ['1'],
  releaseNotes: [{ language: 'ja-JP', text: '最初の版' }],
};
const BUNDLES = [1, 2, 3].map((versionCode) => ({
  versionCode,
  sha256: `b${versionCode}`,
  sha1: 'x',
}));

function setup(tracks: Record<string, FakeRelease[]>) {
  const fake = fakePlay({ bundles: BUNDLES, tracks });
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

function draftIn(fake: ReturnType<typeof setup>['fake'], track = 'production') {
  const [[id] = []] = fake.openEdits();
  return fake.snapshotOf(id ?? '')?.tracks[track]?.find(({ status }) => status === 'draft');
}

const request = { packageName: PACKAGE, track: 'production', versionCode: 2 };

describe('selectBuild', () => {
  it('下書きが無ければ作り、公開中のリリースは一緒に送って残す', async () => {
    const { fake, play } = setup({ production: [COMPLETED] });

    const result = await selectBuild(play, request);

    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({ status: 'draft', versionCodes: ['2'] });
    expect(result.pending?.changes).toEqual(['production の下書きのリリースにビルド 2 を選んだ']);
    const [[id] = []] = fake.openEdits();
    expect(fake.snapshotOf(id ?? '')?.tracks.production).toEqual([
      COMPLETED,
      { status: 'draft', versionCodes: ['2'] },
    ]);
    expect(fake.live.tracks.production).toEqual([COMPLETED]);
  });

  it('段階的公開中のリリースも残す', async () => {
    const rollout: FakeRelease = { status: 'inProgress', versionCodes: ['1'], userFraction: 0.1 };
    const { fake, play } = setup({ production: [rollout] });

    await selectBuild(play, request);

    const [[id] = []] = fake.openEdits();
    expect(fake.snapshotOf(id ?? '')?.tracks.production?.[0]).toEqual(rollout);
  });

  it('下書きのビルドを変えると、リリースノートは残し、前のビルドから付いた名前は残さない', async () => {
    const { fake, play } = setup({
      production: [
        {
          name: '3 (1.0.3)',
          status: 'draft',
          versionCodes: ['3'],
          releaseNotes: [{ language: 'ja-JP', text: '直した' }],
        },
      ],
    });

    await selectBuild(play, request);

    expect(draftIn(fake)).toEqual({
      status: 'draft',
      versionCodes: ['2'],
      releaseNotes: [{ language: 'ja-JP', text: '直した' }],
    });
  });

  it('リリースの名前を渡すと、その名前にする', async () => {
    const { fake, play } = setup({ production: [] });

    await selectBuild(play, { ...request, releaseName: '1.0.2' });

    expect(draftIn(fake)).toMatchObject({ name: '1.0.2' });
  });

  it('同じビルドの下書きがすでにあるときは、何も変えず、edit を残さない', async () => {
    const draft: FakeRelease = { name: '1.0.2', status: 'draft', versionCodes: ['2'] };
    const { fake, play } = setup({ production: [draft] });

    const result = await selectBuild(play, request);

    expect(result.before).toEqual(result.after);
    expect(result.pending).toBeNull();
    expect(fake.openEdits()).toEqual([]);
  });

  it('同じビルドで名前だけ違うときは、名前を変える', async () => {
    const draft: FakeRelease = { name: '1.0.2', status: 'draft', versionCodes: ['2'] };
    const { fake, play } = setup({ production: [draft] });

    await selectBuild(play, { ...request, releaseName: '1.0.2-fix' });

    expect(draftIn(fake)).toEqual({ ...draft, name: '1.0.2-fix' });
  });

  it('無いビルドを選ぶと、あるビルドを返し、何も変えない', async () => {
    const { fake, play } = setup({ production: [COMPLETED] });

    await expect(selectBuild(play, { ...request, versionCode: 9 })).rejects.toThrow(
      'ビルド 9 はありません。あるビルドは 3・2・1 です。',
    );

    expect(fake.openEdits()).toEqual([]);
    expect(play.edits.pending(PACKAGE)).toBeNull();
  });

  it('下書きのある別のトラックには、影響しない', async () => {
    const draft: FakeRelease = { status: 'draft', versionCodes: ['1'] };
    const { fake, play } = setup({ production: [], alpha: [draft] });

    await selectBuild(play, { ...request, track: 'alpha', versionCode: 3 });

    expect(draftIn(fake, 'alpha')).toMatchObject({ versionCodes: ['3'] });
    expect(draftIn(fake, 'production')).toBeUndefined();
  });
});
