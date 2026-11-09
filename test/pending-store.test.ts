import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileStore } from '../plugin/src/pending-store.ts';

const PENDING = { id: 'edit-1', expiresAt: '2027-01-15T08:00:00.000Z', changes: ['変えた'] };

async function storePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'gpc-mcp-')), 'data', 'pending-edits.json');
}

describe('createFileStore', () => {
  it('保存したものを、別のインスタンスで読める', async () => {
    const path = await storePath();

    await createFileStore(path).put('com.example.a', PENDING);

    expect(await createFileStore(path).get('com.example.a')).toEqual(PENDING);
    expect(await createFileStore(path).get('com.example.b')).toBeUndefined();
  });

  it('別のアプリの記録を消さない', async () => {
    const path = await storePath();
    const store = createFileStore(path);

    await store.put('com.example.a', PENDING);
    await store.put('com.example.b', { ...PENDING, id: 'edit-2' });
    await store.put('com.example.a', undefined);

    expect(await store.get('com.example.a')).toBeUndefined();
    expect(await store.get('com.example.b')).toMatchObject({ id: 'edit-2' });
  });

  it('自分だけが読めるファイルにする', async () => {
    const path = await storePath();

    await createFileStore(path).put('com.example.a', PENDING);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('壊れたファイルは、空として読む', async () => {
    const path = await storePath();
    const store = createFileStore(path);
    await store.put('com.example.a', PENDING);
    await writeFile(path, 'not json');

    expect(await store.get('com.example.a')).toBeUndefined();

    await store.put('com.example.b', PENDING);
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')))).toEqual(['com.example.b']);
  });
});
