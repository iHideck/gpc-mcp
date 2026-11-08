import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { setLocalizations } from '../plugin/src/set-localizations.ts';
import { apiError, fakePlay, type FakeListing, type FakeRelease } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const JA: FakeListing = {
  language: 'ja-JP',
  title: 'アプリ',
  shortDescription: '短い説明',
  fullDescription: '詳しい説明',
  video: 'https://www.youtube.com/watch?v=abc',
};
const EN: FakeListing = {
  language: 'en-US',
  title: 'App',
  shortDescription: 'Short',
  fullDescription: 'Full',
};
const COMPLETED: FakeRelease = { name: '1.0.0', status: 'completed', versionCodes: ['1'] };
const DRAFT: FakeRelease = {
  status: 'draft',
  versionCodes: ['2'],
  releaseNotes: [{ language: 'en-US', text: 'Fixed' }],
};

function setup(options: Parameters<typeof fakePlay>[0] = {}) {
  const fake = fakePlay({
    listings: [JA, EN],
    tracks: { production: [COMPLETED, DRAFT] },
    ...options,
  });
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

function snapshot(fake: ReturnType<typeof setup>['fake']) {
  const [[id] = []] = fake.openEdits();
  return fake.snapshotOf(id ?? '');
}

const request = (localizations: Parameters<typeof setLocalizations>[1]['localizations']) => ({
  packageName: PACKAGE,
  track: 'production',
  localizations,
});

describe('setLocalizations', () => {
  it('渡した項目だけを変え、前と後を返す。公開中の状態は変えない', async () => {
    const { fake, play } = setup();

    const result = await setLocalizations(
      play,
      request([{ locale: 'ja-JP', title: '新しい名前' }]),
    );

    expect(result.changes).toEqual([
      { locale: 'ja-JP', field: 'title', before: 'アプリ', after: '新しい名前' },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.pending?.changes).toEqual(['ja-JP のタイトルを変えた']);
    expect(snapshot(fake)?.listings).toContainEqual({ ...JA, title: '新しい名前' });
    expect(fake.live.listings).toEqual([JA, EN]);
  });

  it('動画の URL は、null で消す', async () => {
    const { fake, play } = setup();

    const result = await setLocalizations(play, request([{ locale: 'ja-JP', video: null }]));

    expect(result.changes).toEqual([
      { locale: 'ja-JP', field: 'video', before: JA.video, after: null },
    ]);
    expect(
      snapshot(fake)?.listings.find(({ language }) => language === 'ja-JP'),
    ).not.toHaveProperty('video');
  });

  it('同じ値なら、何も送らず、edit も残さない', async () => {
    const { fake, play } = setup();

    const result = await setLocalizations(
      play,
      request([{ locale: 'ja-JP', title: JA.title ?? '' }]),
    );

    expect(result.changes).toEqual([]);
    expect(result.pending).toBeNull();
    expect(fake.openEdits()).toEqual([]);
  });

  it('文字数は全角と半角を区別せず、絵文字も1文字に数える', async () => {
    const { play } = setup();

    await expect(
      setLocalizations(play, request([{ locale: 'ja-JP', title: '😀'.repeat(30) }])),
    ).resolves.toMatchObject({ changes: [expect.objectContaining({ field: 'title' })] });
  });

  it('上限を超えた文と URL でないものは、全部を挙げて、何も送らない', async () => {
    const { fake, play } = setup();

    await expect(
      setLocalizations(
        play,
        request([
          {
            locale: 'ja-JP',
            title: 'あ'.repeat(31),
            shortDescription: 'あ'.repeat(81),
            fullDescription: 'あ'.repeat(4001),
            video: 'youtube.com/x',
            releaseNotes: 'あ'.repeat(501),
          },
        ]),
      ),
    ).rejects.toThrow(
      [
        '- ja-JP のタイトル: 31 文字（30 文字まで）',
        '- ja-JP の簡単な説明: 81 文字（80 文字まで）',
        '- ja-JP の詳しい説明: 4001 文字（4000 文字まで）',
        '- ja-JP の動画の URL: http か https の URL ではありません',
        '- ja-JP のリリースノート: 501 文字（500 文字まで）',
      ].join('\n'),
    );

    expect(fake.requests()).toEqual([]);
  });

  it('同じ言語を2回渡すと、まとめるように返す', async () => {
    const { play } = setup();

    await expect(
      setLocalizations(
        play,
        request([
          { locale: 'ja-JP', title: 'A' },
          { locale: 'ja-JP', title: 'B' },
        ]),
      ),
    ).rejects.toThrow('言語 ja-JP が2回以上あります');
  });

  it('無い言語は、必要な文を全部渡すと新しく作り、知らせる', async () => {
    const { fake, play } = setup();

    const result = await setLocalizations(
      play,
      request([
        { locale: 'ko-KR', title: '앱', shortDescription: '짧은', fullDescription: '긴 설명' },
      ]),
    );

    expect(result.changes.map(({ field }) => field)).toEqual([
      'title',
      'shortDescription',
      'fullDescription',
    ]);
    expect(result.warnings).toEqual(['言語 ko-KR の掲載情報を新しく作りました。']);
    expect(snapshot(fake)?.listings).toContainEqual({
      language: 'ko-KR',
      title: '앱',
      shortDescription: '짧은',
      fullDescription: '긴 설명',
    });
  });

  it('無い言語で文が足りないときは、足りない項目とある言語を返し、何も変えない', async () => {
    const { fake, play } = setup();

    await expect(
      setLocalizations(
        play,
        request([
          { locale: 'ja-JP', title: '変える' },
          { locale: 'ko-KR', title: '앱' },
        ]),
      ),
    ).rejects.toThrow(/簡単な説明・詳しい説明も要ります。ある言語は ja-JP、en-US です/);

    expect(fake.openEdits()).toEqual([]);
  });

  it('リリースノートは下書きのリリースに入れ、ほかの言語の文とほかのリリースは残す', async () => {
    const { fake, play } = setup();

    const result = await setLocalizations(
      play,
      request([{ locale: 'ja-JP', releaseNotes: '直した' }]),
    );

    expect(result.changes).toEqual([
      { locale: 'ja-JP', field: 'releaseNotes', before: null, after: '直した' },
    ]);
    expect(result.pending?.changes).toEqual(['ja-JP のリリースノートを変えた']);
    expect(snapshot(fake)?.tracks.production).toEqual([
      COMPLETED,
      {
        ...DRAFT,
        releaseNotes: [
          { language: 'en-US', text: 'Fixed' },
          { language: 'ja-JP', text: '直した' },
        ],
      },
    ]);
  });

  it('リリースノートが同じなら、何も送らず、edit も残さない', async () => {
    const { fake, play } = setup();

    const result = await setLocalizations(
      play,
      request([{ locale: 'en-US', releaseNotes: 'Fixed' }]),
    );

    expect(result.changes).toEqual([]);
    expect(fake.requests().filter((request) => request.startsWith('PUT'))).toEqual([]);
    expect(fake.openEdits()).toEqual([]);
  });

  it('リリースノートは、空の文字で消す', async () => {
    const { fake, play } = setup();

    await setLocalizations(play, request([{ locale: 'en-US', releaseNotes: '' }]));

    expect(snapshot(fake)?.tracks.production?.[1]?.releaseNotes).toEqual([]);
  });

  it('下書きが無いのにリリースノートを渡すと、先にビルドを選ぶように返し、掲載の文も変えない', async () => {
    const { fake, play } = setup({ tracks: { production: [COMPLETED] } });

    await expect(
      setLocalizations(
        play,
        request([{ locale: 'ja-JP', title: '変える', releaseNotes: '直した' }]),
      ),
    ).rejects.toThrow('select_build でビルドを選んでから');

    expect(fake.openEdits()).toEqual([]);
  });

  it('途中で止まったら、済んだ所を知らせ、やり直すと残りだけを行う', async () => {
    const { fake, play } = setup({
      failures: {
        [`PUT /androidpublisher/v3/applications/${PACKAGE}/edits/edit-1/listings/en-US`]: apiError(
          500,
          'internal',
        ),
      },
    });
    const both = request([
      { locale: 'ja-JP', title: '新' },
      { locale: 'en-US', title: 'New' },
    ]);

    await expect(setLocalizations(play, both)).rejects.toThrow(
      /ja-JP のタイトルを変えました。en-US のタイトルを変えるところで止まりました/,
    );
    const retried = await setLocalizations(play, both);

    expect(retried.changes.map(({ locale }) => locale)).toEqual(['en-US']);
    expect(retried.pending?.changes).toEqual([
      'ja-JP のタイトルを変えた',
      'en-US のタイトルを変えた',
    ]);
    expect(fake.openEdits()).toHaveLength(1);
  });

  it('Google が値を直して保存したら、warnings で知らせる', async () => {
    const { play, fake } = setup();
    const original = fake.fetch.getMockImplementation() as typeof fetch;
    fake.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (init?.method === 'PUT' && String(input).includes('/listings/ja-JP')) {
        return new Response(JSON.stringify({ ...JA, title: '直された名前' }), { status: 200 });
      }
      return response;
    });

    const result = await setLocalizations(play, request([{ locale: 'ja-JP', title: '名前' }]));

    expect(result.warnings).toEqual([
      'Google Play の値が、頼んだものと違います: ja-JP のタイトル（Google が直したかもしれません。get_localizations で確かめてください）',
    ]);
  });
});
