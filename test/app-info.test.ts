import { describe, expect, it } from 'vitest';
import { setAppInfo } from '../plugin/src/app-info.ts';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { createMemoryStore } from '../plugin/src/pending-store.ts';
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

  describe('sameAsApp', () => {
    const SOURCE = {
      defaultLanguage: 'en-US',
      contactEmail: 'source@example.com',
      contactWebsite: 'https://source.example.com',
    };

    // 偽の Google Play は1つのアプリの状態だけを持つので、写す元のアプリの応答を差し替える
    function setupWithSource() {
      const { fake, play } = setup();
      const original = fake.fetch.getMockImplementation() as typeof fetch;
      let reads = 0;
      fake.fetch.mockImplementation(async (input, init) => {
        const url = String(input);
        const response = await original(input, init);
        if (url.includes('com.example.source') && url.endsWith('/details') && (reads += 1)) {
          return new Response(JSON.stringify(SOURCE), { status: 200 });
        }
        return response;
      });
      return { fake, play };
    }

    it('連絡先を写し、既定の言語は写さない。写す元に無い項目は変えずに知らせる', async () => {
      const { play } = setupWithSource();

      const result = await setAppInfo(play, {
        packageName: PACKAGE,
        sameAsApp: 'com.example.source',
      });

      expect(result.after).toEqual({
        ...DETAILS,
        contactEmail: SOURCE.contactEmail,
        contactWebsite: SOURCE.contactWebsite,
      });
      expect(result.missingInSource).toEqual(['contactPhone']);
    });

    it('渡した項目は、写す元より優先する', async () => {
      const { play } = setupWithSource();

      const result = await setAppInfo(play, {
        packageName: PACKAGE,
        sameAsApp: 'com.example.source',
        contactEmail: 'given@example.com',
      });

      expect(result.after.contactEmail).toBe('given@example.com');
      expect(result.after.contactWebsite).toBe(SOURCE.contactWebsite);
    });

    it('まだ送っていない変更があるときは、別のアプリの edit を作らずに断る', async () => {
      const { fake, play } = setupWithSource();
      await setAppInfo(play, { packageName: PACKAGE, defaultLanguage: 'en-US' });
      fake.fetch.mockClear();

      await expect(
        setAppInfo(play, { packageName: PACKAGE, sameAsApp: 'com.example.source' }),
      ).rejects.toThrow('まだ送っていない変更があるので');

      expect(fake.requests().some((request) => request.includes('com.example.source'))).toBe(false);
      expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(1);
    });

    it('写す元のアプリにまだ送っていない変更があるときも、断る', async () => {
      const { fake, play } = setupWithSource();
      await setAppInfo(play, { packageName: 'com.example.source', defaultLanguage: 'fr-FR' });

      await expect(
        setAppInfo(play, { packageName: PACKAGE, sameAsApp: 'com.example.source' }),
      ).rejects.toThrow('com.example.source にまだ送っていない変更があるので');

      expect(play.edits.pending('com.example.source')?.changes).toHaveLength(1);
      expect(fake.openEdits()).toHaveLength(1);
    });

    it('起動し直したあとも、写す元の保存した変更を見て断る', async () => {
      const fake = fakePlay({ details: DETAILS });
      const store = createMemoryStore();
      const client = createClient(async () => 'TOKEN', fake.fetch);
      await setAppInfo(createPlay(client, store), {
        packageName: 'com.example.source',
        contactEmail: 'changed@example.com',
      });

      await expect(
        setAppInfo(createPlay(client, store), {
          packageName: PACKAGE,
          sameAsApp: 'com.example.source',
        }),
      ).rejects.toThrow('com.example.source にまだ送っていない変更があるので');
    });

    it('同時に呼んだ書くツールの変更を、確かめたあとに割り込ませない', async () => {
      const { fake, play } = setupWithSource();

      const [copied, written] = await Promise.allSettled([
        setAppInfo(play, { packageName: PACKAGE, sameAsApp: 'com.example.source' }),
        setAppInfo(play, { packageName: PACKAGE, defaultLanguage: 'en-US' }),
      ]);

      expect(copied.status).toBe('fulfilled');
      expect(written.status).toBe('fulfilled');
      expect(fake.openEdits()).toHaveLength(1);
      expect(play.edits.pending(PACKAGE)?.changes).toHaveLength(2);
    });

    it('同じアプリを渡すと断る', async () => {
      const { play } = setupWithSource();

      await expect(setAppInfo(play, { packageName: PACKAGE, sameAsApp: PACKAGE })).rejects.toThrow(
        '別のアプリのパッケージ名',
      );
    });
  });

  it('ウェブサイトが URL でなければ、何も送らない', async () => {
    const { fake, play } = setup();

    await expect(
      setAppInfo(play, { packageName: PACKAGE, contactWebsite: 'example.com' }),
    ).rejects.toThrow('http か https の URL ではありません');

    expect(fake.requests()).toEqual([]);
  });
});
