import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { createTrack } from '../plugin/src/tracks.ts';
import { fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const request = { packageName: PACKAGE, track: 'closed-1', formFactor: 'DEFAULT' as const };

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

  it('Wear OS のトラックは、機種の種類を付けて作る', async () => {
    const { fake, play } = setup();

    await createTrack(play, { ...request, track: 'wear:closed-1', formFactor: 'WEAR' });

    const call = fake.fetch.mock.calls.find(([input, init]) => {
      return init?.method === 'POST' && String(input).endsWith('/tracks');
    });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      track: 'wear:closed-1',
      type: 'CLOSED_TESTING',
      formFactor: 'WEAR',
    });
  });
});
