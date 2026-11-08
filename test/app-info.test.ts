import { describe, expect, it } from 'vitest';
import { setAppInfo } from '../plugin/src/app-info.ts';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const DETAILS = {
  defaultLanguage: 'ja-JP',
  contactEmail: 'me@example.com',
  contactPhone: '+81-3-0000-0000',
  contactWebsite: 'https://example.com',
};

function setup() {
  const fake = fakePlay({ details: DETAILS });
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

describe('setAppInfo', () => {
  it('渡した項目だけを変え、前と後を返す', async () => {
    const { fake, play } = setup();

    const result = await setAppInfo(play, {
      packageName: PACKAGE,
      contactEmail: 'new@example.com',
    });

    expect(result.before).toEqual(DETAILS);
    expect(result.after).toEqual({ ...DETAILS, contactEmail: 'new@example.com' });
    expect(result.pending?.changes).toEqual(['App の情報（contactEmail）を変えた']);
    expect(fake.live.details).toEqual(DETAILS);
  });

  it('電話番号とウェブサイトは、null で消す', async () => {
    const { play } = setup();

    const result = await setAppInfo(play, {
      packageName: PACKAGE,
      contactPhone: null,
      contactWebsite: '',
    });

    expect(result.after).toEqual({ ...DETAILS, contactPhone: null, contactWebsite: null });
  });

  it('同じ値なら、何も送らず、edit も残さない', async () => {
    const { fake, play } = setup();

    const result = await setAppInfo(play, { packageName: PACKAGE, defaultLanguage: 'ja-JP' });

    expect(result.before).toEqual(result.after);
    expect(result.pending).toBeNull();
    expect(fake.openEdits()).toEqual([]);
  });

  it('ウェブサイトが URL でなければ、何も送らない', async () => {
    const { fake, play } = setup();

    await expect(
      setAppInfo(play, { packageName: PACKAGE, contactWebsite: 'example.com' }),
    ).rejects.toThrow('http か https の URL ではありません');

    expect(fake.requests()).toEqual([]);
  });
});
