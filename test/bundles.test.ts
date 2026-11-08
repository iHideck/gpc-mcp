import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uploadBundle } from '../plugin/src/bundles.ts';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const CONTENT = Buffer.from('fake app bundle');

async function bundleFile(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'gpc-mcp-')), 'app-release.aab');
  await writeFile(path, CONTENT);
  return path;
}

function setup(options: Parameters<typeof fakePlay>[0] = {}) {
  const fake = fakePlay(options);
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

describe('uploadBundle', () => {
  it('ファイルの中身を上げ、まだ送っていない変更に入れる', async () => {
    const { fake, play } = setup({ nextVersionCode: 12 });

    const result = await uploadBundle(play, { packageName: PACKAGE, file: await bundleFile() });

    expect(result).toEqual({
      packageName: PACKAGE,
      versionCode: 12,
      uploaded: true,
      pending: { expiresAt: expect.any(String), changes: ['App Bundle app-release.aab を上げた'] },
    });
    expect(fake.live.bundles).toEqual([]);
    const [[id] = []] = fake.openEdits();
    expect(fake.snapshotOf(id ?? '')?.bundles[0]?.sha256).toBe(
      createHash('sha256').update(CONTENT).digest('hex'),
    );
    const upload = fake.fetch.mock.calls.find(([input]) => String(input).includes('/upload/'));
    expect(new URL(String(upload?.[0])).searchParams.get('uploadType')).toBe('media');
    expect(upload?.[1]?.headers).toMatchObject({ 'Content-Type': 'application/octet-stream' });
  });

  it('同じファイルがもうあれば、上げ直さず、edit も残さない', async () => {
    const { fake, play } = setup({
      bundles: [
        { versionCode: 5, sha256: createHash('sha256').update(CONTENT).digest('hex'), sha1: 'x' },
      ],
    });

    const result = await uploadBundle(play, { packageName: PACKAGE, file: await bundleFile() });

    expect(result).toMatchObject({ versionCode: 5, uploaded: false, pending: null });
    expect(
      fake.requests().some((request) => request.startsWith('POST') && request.includes('/bundles')),
    ).toBe(false);
    expect(fake.openEdits()).toEqual([]);
  });

  it.each([
    ['絶対パスでない', 'app-release.aab', '絶対パス'],
    ['.aab でない', '/tmp/app-release.apk', '.aab'],
    ['無い', '/nonexistent/app-release.aab', '読めません'],
  ])('ファイルのパスが%sときは、edit を作らない', async (_, file, message) => {
    const { fake, play } = setup();

    await expect(uploadBundle(play, { packageName: PACKAGE, file })).rejects.toThrow(message);

    expect(fake.requests()).toEqual([]);
  });
});
