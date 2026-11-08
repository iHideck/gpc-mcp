import { describe, expect, it } from 'vitest';
import { createClient, UnknownOutcomeError } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { listTracks, readTrack, writeTrack } from '../plugin/src/tracks.ts';
import { apiError, fakePlay, type FakeRelease } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const COMPLETED: FakeRelease = { name: '1.0.0', status: 'completed', versionCodes: ['1'] };
const DRAFT: FakeRelease = { status: 'draft', versionCodes: ['2'] };

function setup(options: Parameters<typeof fakePlay>[0] = { tracks: { production: [COMPLETED] } }) {
  const fake = fakePlay(options);
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

function addDraft(play: ReturnType<typeof setup>['play'], change = '下書きを足した') {
  return play.edits.write(PACKAGE, (edit) =>
    edit.change(change, () => writeTrack(play.client, edit, 'production', [COMPLETED, DRAFT])),
  );
}

function statuses(play: ReturnType<typeof setup>['play']) {
  return play.edits.read(PACKAGE, async (edit) =>
    (await listTracks(play.client, edit)).flatMap(({ releases }) =>
      releases.map(({ status }) => status),
    ),
  );
}

describe('まだ送っていない edit', () => {
  it('変えた edit は残り、Google Play の公開中の状態は変わらない', async () => {
    const { fake, play } = setup();

    await addDraft(play);

    expect(fake.openEdits()).toHaveLength(1);
    expect(fake.live.tracks.production).toEqual([COMPLETED]);
    expect(play.edits.pending(PACKAGE)).toEqual({
      expiresAt: '2027-01-15T08:00:00.000Z',
      changes: ['下書きを足した'],
    });
  });

  it('読むときは、新しい edit を作らず、まだ送っていない edit を読む', async () => {
    const { fake, play } = setup();
    await addDraft(play);

    expect(await statuses(play)).toEqual(['completed', 'draft']);

    expect(fake.openEdits()).toHaveLength(1);
    expect(fake.requests().filter((request) => request.endsWith('/edits'))).toHaveLength(1);
  });

  it('書くツールは、同じ edit に積み重ねる', async () => {
    const { fake, play } = setup();

    await addDraft(play, '1つ目');
    await addDraft(play, '2つ目');

    expect(fake.requests().filter((request) => request.endsWith('/edits'))).toHaveLength(1);
    expect(play.edits.pending(PACKAGE)?.changes).toEqual(['1つ目', '2つ目']);
  });

  it('同時に書いても、1つの edit に順に入る', async () => {
    const { fake, play } = setup();

    await Promise.all([addDraft(play, '1つ目'), addDraft(play, '2つ目')]);

    expect(fake.requests().filter((request) => request.endsWith('/edits'))).toHaveLength(1);
    expect(fake.openEdits()).toHaveLength(1);
    expect(play.edits.pending(PACKAGE)?.changes).toEqual(['1つ目', '2つ目']);
  });

  it('何も変えなかったら、edit を残さない', async () => {
    const { fake, play } = setup();

    await play.edits.write(PACKAGE, async () => undefined);

    expect(fake.openEdits()).toEqual([]);
    expect(play.edits.pending(PACKAGE)).toBeNull();
  });

  it('途中で失敗しても、前に変えたものは残る', async () => {
    const { fake, play } = setup();
    await addDraft(play);

    await expect(
      play.edits.write(PACKAGE, async () => {
        throw new Error('途中で失敗');
      }),
    ).rejects.toThrow('途中で失敗');

    expect(fake.openEdits()).toHaveLength(1);
    expect(play.edits.pending(PACKAGE)?.changes).toEqual(['下書きを足した']);
  });

  it('Play Console で変えて無効になったら、失われた変更を知らせ、次の呼び出しは新しい edit で動く', async () => {
    const { fake, play } = setup();
    await addDraft(play);
    fake.changeInConsole();

    await expect(statuses(play)).rejects.toThrow(/無効になりました[\s\S]*下書きを足した/);

    expect(play.edits.pending(PACKAGE)).toBeNull();
    expect(await statuses(play)).toEqual(['completed']);
  });

  it('書いている途中で無効になっても、失われた変更を知らせて手放す', async () => {
    const { fake, play } = setup();
    await addDraft(play);

    await expect(
      play.edits.write(PACKAGE, async (edit) => {
        fake.changeInConsole();
        await writeTrack(play.client, edit, 'production', [COMPLETED]);
      }),
    ).rejects.toThrow(/無効になりました[\s\S]*下書きを足した/);

    expect(play.edits.pending(PACKAGE)).toBeNull();
  });

  it('アプリが無いときは、パッケージ名と最初のビルドのことを案内する', async () => {
    const fake = fakePlay({
      failures: {
        [`POST /androidpublisher/v3/applications/${PACKAGE}/edits`]: apiError(
          404,
          'Package not found.',
        ),
      },
    });
    const play = createPlay(createClient(async () => 'TOKEN', fake.fetch));

    await expect(statuses(play)).rejects.toThrow(/最初の App Bundle を上げて[\s\S]*not found/);
  });

  it('届いたのに応答が失われた変更も、届いたか分からない変更として残す', async () => {
    const { fake, play } = setup();
    const original = fake.fetch.getMockImplementation() as typeof fetch;
    fake.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (init?.method === 'PUT') {
        throw new TypeError('fetch failed');
      }
      return response;
    });

    await expect(addDraft(play)).rejects.toThrow('届いたかは分かりません');

    expect(play.edits.pending(PACKAGE)?.changes).toEqual([
      '下書きを足した（届いたかは分かりません）',
    ]);
    expect(fake.openEdits()).toHaveLength(1);
  });

  it('5xx の変更も、届いたか分からない変更として残す', async () => {
    const { play } = setup({
      tracks: { production: [COMPLETED] },
      failures: {
        [`PUT /androidpublisher/v3/applications/${PACKAGE}/edits/edit-1/tracks/production`]:
          apiError(503, 'unavailable'),
      },
    });

    await expect(addDraft(play)).rejects.toThrow('503');

    expect(play.edits.pending(PACKAGE)?.changes).toEqual([
      '下書きを足した（届いたかは分かりません）',
    ]);
  });

  it('Google が断った変更は残さず、edit も消す', async () => {
    const { fake, play } = setup({
      tracks: { production: [COMPLETED] },
      failures: {
        [`PUT /androidpublisher/v3/applications/${PACKAGE}/edits/edit-1/tracks/production`]:
          apiError(400, 'bad request'),
      },
    });

    await expect(addDraft(play)).rejects.toThrow('400');

    expect(play.edits.pending(PACKAGE)).toBeNull();
    expect(fake.openEdits()).toEqual([]);
  });

  it('書かない設定で送らなかった変更は、残さない', async () => {
    const fake = fakePlay({ tracks: { production: [COMPLETED] } });
    const play = createPlay(createClient(async () => 'TOKEN', fake.fetch, true));

    await expect(addDraft(play)).rejects.toThrow('送りませんでした');

    expect(play.edits.pending(PACKAGE)).toBeNull();
    expect(fake.openEdits()).toEqual([]);
  });

  it('届いたか分からない変更をやり直して届いたら、確かな記録に置き換える', async () => {
    const { play } = setup({
      tracks: { production: [COMPLETED] },
      failures: {
        [`PUT /androidpublisher/v3/applications/${PACKAGE}/edits/edit-1/tracks/production`]:
          apiError(503, 'unavailable'),
      },
    });

    await expect(addDraft(play)).rejects.toThrow('503');
    await addDraft(play);

    expect(play.edits.pending(PACKAGE)?.changes).toEqual(['下書きを足した']);
  });

  it('届いた変更をやり直して失敗しても、確かな記録のままにする', async () => {
    const { play } = setup({ tracks: { production: [COMPLETED] } });
    await addDraft(play);

    await expect(
      play.edits.write(PACKAGE, (edit) =>
        edit.change('下書きを足した', async () => {
          throw new UnknownOutcomeError('fetch failed');
        }),
      ),
    ).rejects.toThrow('fetch failed');

    expect(play.edits.pending(PACKAGE)?.changes).toEqual(['下書きを足した']);
  });

  it('同じ変更は、一度だけ残す', async () => {
    const { play } = setup();

    await addDraft(play);
    await addDraft(play);

    expect(play.edits.pending(PACKAGE)?.changes).toEqual(['下書きを足した']);
  });

  it('edit が無効になった 404 を、空のトラックと読み違えない', async () => {
    const { fake, play } = setup({
      tracks: { production: [COMPLETED] },
      failures: {
        [`GET /androidpublisher/v3/applications/${PACKAGE}/edits/edit-1/tracks/production`]:
          apiError(404, 'Edit not found.', 'editNotFound'),
      },
    });
    await addDraft(play);

    await expect(
      play.edits.read(PACKAGE, (edit) => readTrack(play.client, edit, 'production')),
    ).rejects.toThrow('無効になりました');

    expect(play.edits.pending(PACKAGE)).toBeNull();
    expect(fake.openEdits()).toHaveLength(1);
  });

  it('別のアプリの呼び出しも順番に行い、作業中の edit を無効にしない', async () => {
    const { play } = setup();

    const [written] = await Promise.all([
      play.edits.write(PACKAGE, async (edit) => {
        await new Promise((resolve) => setImmediate(resolve));
        return edit.change('下書きを足した', () =>
          writeTrack(play.client, edit, 'production', [COMPLETED, DRAFT]),
        );
      }),
      play.edits.read('com.example.other', async () => 'read'),
    ]);

    expect(written).toEqual([COMPLETED, DRAFT]);
  });

  it('捨てると、edit を消し、捨てた変更を返す。何も無ければ null を返す', async () => {
    const { fake, play } = setup();
    await addDraft(play);

    expect(await play.edits.discard(PACKAGE)).toMatchObject({ changes: ['下書きを足した'] });

    expect(fake.openEdits()).toEqual([]);
    expect(fake.live.tracks.production).toEqual([COMPLETED]);
    expect(await play.edits.discard(PACKAGE)).toBeNull();
  });
});
