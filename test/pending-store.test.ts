import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileStore } from '../plugin/src/pending-store.ts';

const PENDING = { id: 'edit-1', expiresAt: '2027-01-15T08:00:00.000Z', changes: ['変えた'] };

async function storeDirectory(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'gpc-mcp-')), 'data', 'pending-edits');
}

describe('createFileStore', () => {
  it('保存したものを、別のインスタンスで読める', async () => {
    const directory = await storeDirectory();

    await createFileStore(directory).put('com.example.a', PENDING);

    expect(await createFileStore(directory).get('com.example.a')).toEqual(PENDING);
    expect(await createFileStore(directory).get('com.example.b')).toBeUndefined();
  });

  it('消すと読めなくなり、無いものを消しても失敗しない', async () => {
    const store = createFileStore(await storeDirectory());

    await store.put('com.example.a', PENDING);
    await store.put('com.example.a', undefined);
    await store.put('com.example.a', undefined);

    expect(await store.get('com.example.a')).toBeUndefined();
  });

  it('同時に保存しても、ほかのアプリの記録を消さない', async () => {
    const directory = await storeDirectory();
    const names = ['com.example.a', 'com.example.b', 'com.example.c', 'com.example.d'];

    await Promise.all(names.map((name) => createFileStore(directory).put(name, PENDING)));

    expect((await readdir(directory)).sort()).toEqual(names.map((name) => `${name}.json`));
  });

  it('自分だけが読めるファイルにする', async () => {
    const directory = await storeDirectory();

    await createFileStore(directory).put('com.example.a', PENDING);

    expect((await stat(join(directory, 'com.example.a.json'))).mode & 0o777).toBe(0o600);
  });

  it('壊れたファイルは、そのアプリだけを無いものとして読む', async () => {
    const directory = await storeDirectory();
    const store = createFileStore(directory);
    await store.put('com.example.a', PENDING);
    await store.put('com.example.b', PENDING);
    await writeFile(join(directory, 'com.example.a.json'), 'not json');

    expect(await store.get('com.example.a')).toBeUndefined();
    expect(await store.get('com.example.b')).toEqual(PENDING);
  });

  it('パッケージ名にパスの区切りがあっても、フォルダの外に書かない', async () => {
    const directory = await storeDirectory();

    await createFileStore(directory).put('../outside', PENDING);

    expect(await readdir(directory)).toEqual(['..%2Foutside.json']);
  });
});
