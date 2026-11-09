import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { getReleaseStatus } from '../plugin/src/release-status.ts';
import { apiError, fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';

function setup(options: Parameters<typeof fakePlay>[0]) {
  const fake = fakePlay(options);
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

describe('getReleaseStatus', () => {
  it('新しい5つのビルドと、リリースのあるトラックだけを、審査の状態を付けて返す', async () => {
    const { play } = setup({
      bundles: [1, 2, 3, 4, 5, 6].map((versionCode) => ({
        versionCode,
        sha256: `b${versionCode}`,
        sha1: 'x',
      })),
      apks: [{ versionCode: 7, binary: { sha256: 'a7', sha1: 'x' } }],
      tracks: {
        production: [
          {
            name: '1.2.0',
            status: 'inProgress',
            userFraction: 0.2,
            versionCodes: ['6'],
            releaseNotes: [{ language: 'ja-JP', text: '直した' }],
          },
          { name: '1.1.0', status: 'completed', versionCodes: ['5'] },
        ],
        beta: [],
      },
      lifecycle: {
        production: [
          {
            releaseName: '1.2.0',
            releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW',
            activeArtifacts: [{ versionCode: 6 }],
            track: 'production',
          },
        ],
      },
    });

    expect(await getReleaseStatus(play, PACKAGE)).toEqual({
      packageName: PACKAGE,
      builds: [
        { versionCode: 7, kind: 'apk', sha256: 'a7' },
        { versionCode: 6, kind: 'bundle', sha256: 'b6' },
        { versionCode: 5, kind: 'bundle', sha256: 'b5' },
        { versionCode: 4, kind: 'bundle', sha256: 'b4' },
        { versionCode: 3, kind: 'bundle', sha256: 'b3' },
      ],
      tracks: [
        {
          track: 'production',
          releases: [
            {
              name: '1.2.0',
              status: 'inProgress',
              versionCodes: ['6'],
              userFraction: 0.2,
              releaseNotesLocales: ['ja-JP'],
              countryTargeting: null,
            },
            {
              name: '1.1.0',
              status: 'completed',
              versionCodes: ['5'],
              userFraction: null,
              releaseNotesLocales: [],
              countryTargeting: null,
            },
          ],
          review: [{ releaseName: '1.2.0', state: 'IN_REVIEW', versionCodes: [6] }],
        },
      ],
      pending: null,
      warnings: [],
    });
  });

  it('読み終えたら、一時的な edit を消す', async () => {
    const { fake, play } = setup({});

    await getReleaseStatus(play, PACKAGE);

    expect(fake.openEdits()).toEqual([]);
  });

  it('審査の状態を読めなくても、ほかは返し、warnings で知らせる', async () => {
    const { play } = setup({
      tracks: { production: [{ name: '1.0.0', status: 'completed', versionCodes: ['1'] }] },
      failures: {
        [`GET /androidpublisher/v3/applications/${PACKAGE}/tracks/production/releases`]: apiError(
          403,
          'denied',
        ),
      },
    });

    const status = await getReleaseStatus(play, PACKAGE);

    expect(status.tracks[0]?.review).toBeNull();
    expect(status.warnings).toEqual(['production の審査の状態を読めませんでした（403）。']);
  });

  it('同時に呼んでも、edit を順番に作るので、互いに無効にしない', async () => {
    const { fake, play } = setup({
      tracks: { production: [{ name: '1.0.0', status: 'completed', versionCodes: ['1'] }] },
    });

    const [first, second] = await Promise.all([
      getReleaseStatus(play, PACKAGE),
      getReleaseStatus(play, PACKAGE),
    ]);

    expect(first.tracks).toEqual(second.tracks);
    const requests = fake.requests().filter((request) => /edits(\/edit-\d+)?$/.test(request));
    expect(requests.map((request) => request.split(' ')[0])).toEqual([
      'POST',
      'DELETE',
      'POST',
      'DELETE',
    ]);
  });
});
