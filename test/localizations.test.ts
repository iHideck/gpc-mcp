import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { getLocalizations } from '../plugin/src/localizations.ts';
import { fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';

function setup(options: Parameters<typeof fakePlay>[0]) {
  return createPlay(createClient(async () => 'TOKEN', fakePlay(options).fetch));
}

const listings = [
  {
    language: 'ja-JP',
    title: 'アプリ',
    shortDescription: '短い説明',
    fullDescription: '詳しい説明',
    video: 'https://www.youtube.com/watch?v=abc',
  },
  { language: 'en-US', title: 'App' },
];

const notes = (text: string) => [
  { language: 'ja-JP', text },
  { language: 'en-US', text: `${text} (en)` },
];

describe('getLocalizations', () => {
  it('言語ごとの掲載の文と既定の言語を返す。下書きのリリースがあれば、そのリリースノートを返す', async () => {
    const play = setup({
      details: { defaultLanguage: 'ja-JP', contactEmail: 'me@example.com' },
      listings,
      tracks: {
        production: [
          { status: 'completed', versionCodes: ['3'], releaseNotes: notes('前の版') },
          { status: 'draft', versionCodes: ['2'], releaseNotes: notes('次の版') },
        ],
      },
    });

    expect(await getLocalizations(play, { packageName: PACKAGE, track: 'production' })).toEqual({
      packageName: PACKAGE,
      defaultLanguage: 'ja-JP',
      listings: [
        {
          locale: 'ja-JP',
          title: 'アプリ',
          shortDescription: '短い説明',
          fullDescription: '詳しい説明',
          video: 'https://www.youtube.com/watch?v=abc',
        },
        {
          locale: 'en-US',
          title: 'App',
          shortDescription: null,
          fullDescription: null,
          video: null,
        },
      ],
      releaseNotes: {
        track: 'production',
        release: {
          name: null,
          status: 'draft',
          versionCodes: ['2'],
          userFraction: null,
          releaseNotesLocales: ['ja-JP', 'en-US'],
        },
        notes: [
          { locale: 'ja-JP', text: '次の版' },
          { locale: 'en-US', text: '次の版 (en)' },
        ],
      },
      pending: null,
    });
  });

  it('下書きが無ければ、いちばん新しいリリースのリリースノートを返す', async () => {
    const play = setup({
      listings,
      tracks: {
        production: [
          { status: 'completed', versionCodes: ['9'], releaseNotes: notes('9') },
          { status: 'inProgress', versionCodes: ['10'], releaseNotes: notes('10') },
        ],
      },
    });

    const { releaseNotes } = await getLocalizations(play, {
      packageName: PACKAGE,
      track: 'production',
    });

    expect(releaseNotes?.release.versionCodes).toEqual(['10']);
  });

  it('リリースが無いトラックでは、リリースノートは null', async () => {
    const play = setup({ listings });

    const { releaseNotes } = await getLocalizations(play, {
      packageName: PACKAGE,
      track: 'production',
    });

    expect(releaseNotes).toBeNull();
  });

  it('locales で絞る', async () => {
    const play = setup({
      listings,
      tracks: { production: [{ status: 'draft', versionCodes: ['2'], releaseNotes: notes('次') }] },
    });

    const result = await getLocalizations(play, {
      packageName: PACKAGE,
      track: 'production',
      locales: ['en-US'],
    });

    expect(result.listings.map(({ locale }) => locale)).toEqual(['en-US']);
    expect(result.releaseNotes?.notes).toEqual([{ locale: 'en-US', text: '次 (en)' }]);
  });

  it('無い言語を locales に渡すと、ある言語を返す', async () => {
    const play = setup({ listings });

    await expect(
      getLocalizations(play, { packageName: PACKAGE, track: 'production', locales: ['ja'] }),
    ).rejects.toThrow('言語 ja の文はありません。ある言語は ja-JP、en-US です。');
  });

  it('無いトラックを渡すと、Google のエラーを返す', async () => {
    const play = setup({ listings });

    await expect(
      getLocalizations(play, { packageName: PACKAGE, track: 'closed-1' }),
    ).rejects.toThrow('Track closed-1 not found');
  });
});
