import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { createTrack } from '../plugin/src/tracks.ts';
import { fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const request = { packageName: PACKAGE, track: 'closed-1' };

function setup() {
  const fake = fakePlay({ tracks: { production: [], alpha: [] } });
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

describe('createTrack', () => {
  it('まだ送っていない変更に入れ、公開中の状態は変えない', async () => {
    const { fake, play } = setup();

    const result = await createTrack(play, request);

    expect(result).toMatchObject({ created: true });
    expect(result.pending?.changes).toEqual(['クローズドテストのトラック closed-1 を作った']);
    const [[id] = []] = fake.openEdits();
    expect(Object.keys(fake.snapshotOf(id ?? '')?.tracks ?? {})).toContain('closed-1');
    expect(Object.keys(fake.live.tracks)).not.toContain('closed-1');
  });

  it('もうあれば、何もせず、edit も残さない', async () => {
    const { fake, play } = setup();

    const result = await createTrack(play, { ...request, track: 'alpha' });

    expect(result).toMatchObject({ created: false, pending: null });
    expect(fake.requests().some((r) => r.startsWith('POST') && r.endsWith('/tracks'))).toBe(false);
    expect(fake.openEdits()).toEqual([]);
  });

  it.each([
    ['closed-1', 'DEFAULT'],
    ['wear:closed-1', 'WEAR'],
    ['automotive:closed-1', 'AUTOMOTIVE'],
  ])('%s は、名前に合う機種の種類（%s）で作る', async (track, formFactor) => {
    const { fake, play } = setup();

    await createTrack(play, { ...request, track });

    const call = fake.fetch.mock.calls.find(([input, init]) => {
      return init?.method === 'POST' && String(input).endsWith('/tracks');
    });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      track,
      type: 'CLOSED_TESTING',
      formFactor,
    });
  });

  it('対応していない接頭辞は、何も送らずに断る', async () => {
    const { fake, play } = setup();

    await expect(createTrack(play, { ...request, track: 'tv:closed-1' })).rejects.toThrow(
      '対応していません',
    );

    expect(fake.requests()).toEqual([]);
  });
});
