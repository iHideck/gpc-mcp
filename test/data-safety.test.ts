import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { setDataSafety } from '../plugin/src/data-safety.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const CSV = [
  'Question ID (machine readable),Response ID (machine readable),Response value,Answer requirement,Human-friendly question label',
  'PSL_DATA_TYPES_PERSONAL,PSL_NAME,TRUE,MULTIPLE_CHOICE,Name',
  'PSL_DATA_TYPES_PERSONAL,PSL_EMAIL,,MULTIPLE_CHOICE,Email address',
  '',
].join('\n');

async function write(name: string, content: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'gpc-mcp-')), name);
  await writeFile(path, content);
  return path;
}

function setup() {
  const fake = fakePlay();
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

describe('setDataSafety', () => {
  it('CSV の中身をそのまま送り、行の数を返す', async () => {
    const { fake, play } = setup();

    const result = await setDataSafety(play, {
      packageName: PACKAGE,
      file: await write('data-safety.csv', CSV),
    });

    expect(result).toEqual({ packageName: PACKAGE, file: 'data-safety.csv', rows: 2 });
    expect(fake.dataSafety()).toBe(CSV);
  });

  it('edit を作らず、すぐ送る', async () => {
    const { fake, play } = setup();

    await setDataSafety(play, { packageName: PACKAGE, file: await write('a.csv', CSV) });

    expect(fake.requests()).toEqual([
      `POST /androidpublisher/v3/applications/${PACKAGE}/dataSafety`,
    ]);
  });

  it.each([
    ['絶対パスでない', 'data-safety.csv', '絶対パス'],
    ['無い', '/nonexistent/data-safety.csv', '読めません'],
  ])('ファイルのパスが%sときは、何も送らない', async (_, file, message) => {
    const { fake, play } = setup();

    await expect(setDataSafety(play, { packageName: PACKAGE, file })).rejects.toThrow(message);

    expect(fake.requests()).toEqual([]);
  });

  it('データセーフティの CSV の形でなければ、何も送らない', async () => {
    const { fake, play } = setup();
    const file = await write('other.csv', 'name,value\na,1\n');

    await expect(setDataSafety(play, { packageName: PACKAGE, file })).rejects.toThrow(
      'データセーフティの CSV ではないようです',
    );

    expect(fake.requests()).toEqual([]);
  });
});
