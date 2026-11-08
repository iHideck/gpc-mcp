import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClient } from '../plugin/src/client.ts';
import { createPlay } from '../plugin/src/edits.ts';
import { replaceScreenshots, type ImageType } from '../plugin/src/screenshots.ts';
import { apiError, fakePlay } from './fake-play.ts';

const PACKAGE = 'com.example.app';
const LISTINGS = [{ language: 'ja-JP', title: 'アプリ' }];

function png(width: number, height: number, colorType = 2, salt = 0): Buffer {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = colorType;
  bytes[39] = salt;
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
  ]);
}

async function write(name: string, bytes: Buffer): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'gpc-mcp-')), name);
  await writeFile(path, bytes);
  return path;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function setup(options: Parameters<typeof fakePlay>[0] = {}) {
  const fake = fakePlay({ listings: LISTINGS, ...options });
  return { fake, play: createPlay(createClient(async () => 'TOKEN', fake.fetch)) };
}

const request = (imageType: ImageType, files: string[]) => ({
  packageName: PACKAGE,
  locale: 'ja-JP',
  imageType,
  files,
});

describe('replaceScreenshots', () => {
  it('前の画像を消してから、渡した順に上げる。公開中の状態は変えない', async () => {
    const [one, two] = [png(1080, 1920, 2, 1), png(1080, 1920, 2, 2)] as const;
    const { fake, play } = setup({
      images: { 'ja-JP/phoneScreenshots': [{ id: 'old', sha256: 'old', sha1: 'x', url: 'u' }] },
    });

    const result = await replaceScreenshots(
      play,
      request('phoneScreenshots', [await write('1.png', one), await write('2.png', two)]),
    );

    expect(result.uploaded).toEqual(['1.png', '2.png']);
    expect(result.removed).toBe(1);
    expect(result.before.map(({ id }) => id)).toEqual(['old']);
    expect(result.after.map(({ sha256 }) => sha256)).toEqual([sha256(one), sha256(two)]);
    expect(result.pending?.changes).toEqual(['ja-JP の phoneScreenshots を入れ替えた']);
    expect(fake.live.images['ja-JP/phoneScreenshots']?.map(({ id }) => id)).toEqual(['old']);
  });

  it('同じ画像が同じ順で入っていれば、何も送らず、edit も残さない', async () => {
    const one = png(1080, 1920);
    const { fake, play } = setup({
      images: {
        'ja-JP/phoneScreenshots': [{ id: 'a', sha256: sha256(one), sha1: 'x', url: 'u' }],
      },
    });

    const result = await replaceScreenshots(
      play,
      request('phoneScreenshots', [await write('1.png', one)]),
    );

    expect(result).toMatchObject({ uploaded: [], removed: 0, pending: null });
    expect(
      fake.requests().filter((r) => !r.startsWith('GET') && !/\/edits(\/edit-\d+)?$/.test(r)),
    ).toEqual([]);
    expect(fake.openEdits()).toEqual([]);
  });

  it('順番だけ違うときは、入れ直して順番をそろえる', async () => {
    const [one, two] = [png(1080, 1920, 2, 1), png(1080, 1920, 2, 2)] as const;
    const { play } = setup({
      images: {
        'ja-JP/phoneScreenshots': [
          { id: 'a', sha256: sha256(two), sha1: 'x', url: 'u' },
          { id: 'b', sha256: sha256(one), sha1: 'x', url: 'u' },
        ],
      },
    });

    const result = await replaceScreenshots(
      play,
      request('phoneScreenshots', [await write('1.png', one), await write('2.png', two)]),
    );

    expect(result.after.map(({ sha256 }) => sha256)).toEqual([sha256(one), sha256(two)]);
  });

  it('JPEG も受け付け、内容の種類を付けて送る', async () => {
    const { fake, play } = setup();

    await replaceScreenshots(
      play,
      request('phoneScreenshots', [await write('1.jpg', jpeg(1080, 1920))]),
    );

    const upload = fake.fetch.mock.calls.find(([input]) => String(input).includes('/upload/'));
    expect(upload?.[1]?.headers).toMatchObject({ 'Content-Type': 'image/jpeg' });
    expect(new URL(String(upload?.[0])).searchParams.get('uploadType')).toBe('media');
  });

  it('アルファのある PNG は、断らずに warnings で知らせる', async () => {
    const { play } = setup();

    const result = await replaceScreenshots(
      play,
      request('phoneScreenshots', [await write('1.png', png(1080, 1920, 6))]),
    );

    expect(result.warnings).toEqual([expect.stringContaining('1.png はアルファのある PNG')]);
  });

  it('アイコンは、アルファがあっても知らせない', async () => {
    const { play } = setup();

    const result = await replaceScreenshots(
      play,
      request('icon', [await write('icon.png', png(512, 512, 6))]),
    );

    expect(result.warnings).toEqual([]);
  });

  it('規格に合わないファイルは、全部を挙げて、何も送らない', async () => {
    const { fake, play } = setup();
    const files = [
      await write('small.png', png(100, 100)),
      await write('tall.png', png(1000, 2100)),
      await write('text.png', Buffer.from('not an image')),
      '/relative/but/missing.png',
    ];

    await expect(replaceScreenshots(play, request('phoneScreenshots', files))).rejects.toThrow(
      /small\.png: 大きさが 100x100 です（各辺は 320〜3840 ピクセル）[\s\S]*tall\.png: 大きさが 1000x2100 です（長い辺は短い辺の 2 倍まで）[\s\S]*text\.png: PNG か JPEG の画像として[\s\S]*missing\.png: ファイルを読めません/,
    );

    expect(fake.requests()).toEqual([]);
  });

  it('大きさの決まっている種類は、その大きさだけを受け付ける', async () => {
    const { play } = setup();

    await expect(
      replaceScreenshots(play, request('featureGraphic', [await write('fg.png', png(1024, 501))])),
    ).rejects.toThrow('大きさが 1024x501 です（1024x500 にする）');
  });

  it('アイコンは PNG だけを受け付ける', async () => {
    const { play } = setup();

    await expect(
      replaceScreenshots(play, request('icon', [await write('icon.jpg', jpeg(512, 512))])),
    ).rejects.toThrow('PNG の画像を渡してください');
  });

  it('1枚だけの種類に2枚渡すと断る', async () => {
    const { fake, play } = setup();
    const file = await write('icon.png', png(512, 512));

    await expect(replaceScreenshots(play, request('icon', [file, file]))).rejects.toThrow(
      '1 枚まで',
    );

    expect(fake.requests()).toEqual([]);
  });

  it('絶対パスでないものは断る', async () => {
    const { play } = setup();

    await expect(
      replaceScreenshots(play, request('phoneScreenshots', ['screenshot.png'])),
    ).rejects.toThrow('絶対パスで渡してください');
  });

  it('途中で止まっても、やり直すと全部がそろう', async () => {
    const [one, two] = [png(1080, 1920, 2, 1), png(1080, 1920, 2, 2)] as const;
    const files = [await write('1.png', one), await write('2.png', two)];
    let uploads = 0;
    const { fake, play } = setup({
      images: { 'ja-JP/phoneScreenshots': [{ id: 'old', sha256: 'old', sha1: 'x', url: 'u' }] },
    });
    const original = fake.fetch.getMockImplementation() as typeof fetch;
    fake.fetch.mockImplementation(async (input, init) => {
      if (String(input).includes('/upload/') && (uploads += 1) === 2) {
        return apiError(500, 'internal');
      }
      return original(input, init);
    });

    await expect(replaceScreenshots(play, request('phoneScreenshots', files))).rejects.toThrow(
      /1\.png を上げました。2\.png を上げるところで止まりました/,
    );
    const retried = await replaceScreenshots(play, request('phoneScreenshots', files));

    expect(retried.after.map(({ sha256 }) => sha256)).toEqual([sha256(one), sha256(two)]);
    expect(retried.pending?.changes).toEqual(['ja-JP の phoneScreenshots を入れ替えた']);
    expect(fake.openEdits()).toHaveLength(1);
  });
});
