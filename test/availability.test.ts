import { describe, expect, it } from 'vitest';
import { getAvailability } from '../plugin/src/availability.ts';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';

function setup(options: Parameters<typeof fakePlay>[0] = {}) {
  return createPlay(createClient(async () => 'TOKEN', fakePlay(options).fetch));
}

describe('getAvailability', () => {
  it('トラックの配信する国を返す', async () => {
    const play = setup({
      availability: {
        production: {
          restOfWorld: true,
          syncWithProduction: false,
          countries: [{ countryCode: 'JP' }, { countryCode: 'US' }],
        },
      },
    });

    expect(await getAvailability(play, { packageName: PACKAGE, track: 'production' })).toEqual({
      packageName: PACKAGE,
      track: 'production',
      syncWithProduction: false,
      restOfWorld: true,
      countries: ['JP', 'US'],
      pending: null,
    });
  });

  it('Google が値を省いたときは、配信しない扱いで返す', async () => {
    const play = setup();

    expect(await getAvailability(play, { packageName: PACKAGE, track: 'alpha' })).toMatchObject({
      syncWithProduction: false,
      restOfWorld: false,
      countries: [],
    });
  });
});
