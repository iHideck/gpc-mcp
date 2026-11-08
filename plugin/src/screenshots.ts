import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { GpcClient } from './client.ts';
import type { PendingSummary, Play } from './edits.ts';
import { trackProgress } from './progress.ts';

type ImageFormat = 'png' | 'jpeg';

type ImageRule = {
  label: string;
  maxFiles: number;
  formats: ImageFormat[];
  // 正確な大きさ（幅x高さ）か、辺の長さの範囲
  size: { exact: string } | { minSide: number; maxSide: number; maxRatio: number };
  maxBytes: number;
  // Play Console ヘルプの規格では、アルファの無い PNG
  noAlpha: boolean;
};

// Discovery の仕様の mediaUpload.maxSize
const MAX_IMAGE_BYTES = 15_728_640;
const ANY_FORMAT: ImageFormat[] = ['png', 'jpeg'];
const screenshot = (label: string, minSide: number, maxSide: number): ImageRule => ({
  label,
  maxFiles: 8,
  formats: ANY_FORMAT,
  size: { minSide, maxSide, maxRatio: 2 },
  maxBytes: MAX_IMAGE_BYTES,
  noAlpha: true,
});

// Play Console ヘルプの「プレビュー アセットを追加する」の規格
export const IMAGE_TYPES = {
  phoneScreenshots: screenshot('電話の画面写真', 320, 3840),
  sevenInchScreenshots: screenshot('7 インチのタブレットの画面写真', 320, 7680),
  tenInchScreenshots: screenshot('10 インチのタブレットの画面写真', 320, 7680),
  tvScreenshots: screenshot('Android TV の画面写真', 320, 3840),
  wearScreenshots: screenshot('Wear OS の画面写真', 384, 3840),
  icon: {
    label: 'アプリのアイコン',
    maxFiles: 1,
    formats: ['png'],
    size: { exact: '512x512' },
    maxBytes: 1024 * 1024,
    noAlpha: false,
  },
  featureGraphic: {
    label: 'フィーチャーグラフィック',
    maxFiles: 1,
    formats: ANY_FORMAT,
    size: { exact: '1024x500' },
    maxBytes: MAX_IMAGE_BYTES,
    noAlpha: true,
  },
  tvBanner: {
    label: 'Android TV のバナー',
    maxFiles: 1,
    formats: ANY_FORMAT,
    size: { exact: '1280x720' },
    maxBytes: MAX_IMAGE_BYTES,
    noAlpha: true,
  },
} satisfies Record<string, ImageRule>;

export type ImageType = keyof typeof IMAGE_TYPES;
export const IMAGE_TYPE_NAMES = Object.keys(IMAGE_TYPES) as [ImageType, ...ImageType[]];
export const MAX_IMAGE_FILES = 8;

const Image = z.object({
  id: z.string(),
  url: z.string().nullish(),
  sha256: z.string().nullish(),
});
const ImageList = z.object({ images: z.array(Image).optional() });
const ImageUpload = z.object({ image: Image });

type ImageResource = z.infer<typeof Image>;

type ImageFile = {
  fileName: string;
  bytes: Buffer<ArrayBuffer>;
  sha256: string;
  contentType: string;
  hasAlpha: boolean;
};

export type ReplaceScreenshotsRequest = {
  packageName: string;
  locale: string;
  imageType: ImageType;
  files: string[];
};

type ImageSummary = { id: string; sha256: string | null; url: string | null };

export type ReplaceScreenshotsResult = {
  packageName: string;
  locale: string;
  imageType: ImageType;
  uploaded: string[];
  removed: number;
  before: ImageSummary[];
  after: ImageSummary[];
  pending: PendingSummary | null;
  warnings: string[];
};

export async function replaceScreenshots(
  { client, edits }: Play,
  { packageName, locale, imageType, files }: ReplaceScreenshotsRequest,
): Promise<ReplaceScreenshotsResult> {
  const images = await readImageFiles(files, imageType);
  return edits.write(packageName, async (edit) => {
    const path = `${edit.path}/listings/${encodeURIComponent(locale)}/${imageType}`;
    const before = await readImages(client, path);
    const warnings = images
      .filter(({ hasAlpha }) => hasAlpha && IMAGE_TYPES[imageType].noAlpha)
      .map(
        ({ fileName }) =>
          `${fileName} はアルファのある PNG です。Google Play の規格はアルファの無い PNG なので、断られたらアルファを外してください。`,
      );
    const result = (
      uploaded: string[],
      removed: number,
      after: ImageResource[],
    ): ReplaceScreenshotsResult => ({
      packageName,
      locale,
      imageType,
      uploaded,
      removed,
      before: before.map(summaryOf),
      after: after.map(summaryOf),
      pending: edits.pending(packageName),
      warnings,
    });
    if (sameImages(before, images)) {
      return result([], 0, before);
    }
    const progress = trackProgress();
    const change = `${locale} の ${imageType} を入れ替えた`;
    // 順番を変える API が無いので、入れ直して順番をそろえる
    if (before.length > 0) {
      await progress.write('前の画像を消す', '前の画像を消しました', () =>
        edit.change(change, () => client.remove(path)),
      );
    }
    for (const { fileName, bytes, contentType } of images) {
      await progress.write(`${fileName} を上げる`, `${fileName} を上げました`, () =>
        edit.change(change, () => client.upload(path, { contentType, bytes }, ImageUpload)),
      );
    }
    const after = await readImages(client, path);
    return result(
      images.map(({ fileName }) => fileName),
      before.length,
      after,
    );
  });
}

function sameImages(current: ImageResource[], wanted: ImageFile[]): boolean {
  return (
    current.length === wanted.length &&
    current.every(({ sha256 }, index) => sha256 === wanted[index]?.sha256)
  );
}

async function readImages(client: GpcClient, path: string): Promise<ImageResource[]> {
  const { images } = await client.get(path, {}, ImageList);
  return images ?? [];
}

function summaryOf({ id, sha256, url }: ImageResource): ImageSummary {
  return { id, sha256: sha256 ?? null, url: url ?? null };
}

async function readImageFiles(paths: string[], imageType: ImageType): Promise<ImageFile[]> {
  const rule: ImageRule = IMAGE_TYPES[imageType];
  if (paths.length > rule.maxFiles) {
    throw new Error(
      `${imageType}（${rule.label}）には ${rule.maxFiles} 枚まで入れられます（${paths.length} 枚渡されました）。何も変えていません。`,
    );
  }
  const checks = await Promise.all(paths.map((path) => checkFile(path, rule)));
  const problems = checks.flatMap((check, index) =>
    'problem' in check ? [`- ${paths[index]}: ${check.problem}`] : [],
  );
  if (problems.length > 0) {
    throw new Error(
      [
        `次の画像は ${imageType}（${rule.label}）に入れられないので、何も変えていません。`,
        ...problems,
      ].join('\n'),
    );
  }
  return checks.flatMap((check) => ('file' in check ? [check.file] : []));
}

async function checkFile(
  path: string,
  rule: ImageRule,
): Promise<{ file: ImageFile } | { problem: string }> {
  if (!isAbsolute(path)) {
    return { problem: '絶対パスで渡してください' };
  }
  let bytes: Buffer<ArrayBuffer>;
  try {
    bytes = await readFile(path);
  } catch {
    return { problem: 'ファイルを読めません' };
  }
  if (bytes.length > rule.maxBytes) {
    return { problem: `${bytes.length} バイトあります（${rule.maxBytes} バイトまで）` };
  }
  const image = parseImage(bytes);
  if (image === undefined) {
    return { problem: 'PNG か JPEG の画像として、大きさを読めません' };
  }
  if (!rule.formats.includes(image.format)) {
    return { problem: `${rule.formats.join('・').toUpperCase()} の画像を渡してください` };
  }
  const sizeProblem = checkSize(image.width, image.height, rule.size);
  if (sizeProblem !== undefined) {
    return { problem: sizeProblem };
  }
  return {
    file: {
      fileName: basename(path),
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: image.format === 'png' ? 'image/png' : 'image/jpeg',
      hasAlpha: image.hasAlpha,
    },
  };
}

function checkSize(width: number, height: number, size: ImageRule['size']): string | undefined {
  const actual = `${width}x${height}`;
  if ('exact' in size) {
    return actual === size.exact ? undefined : `大きさが ${actual} です（${size.exact} にする）`;
  }
  const shorter = Math.min(width, height);
  const longer = Math.max(width, height);
  if (shorter < size.minSide || longer > size.maxSide) {
    return `大きさが ${actual} です（各辺は ${size.minSide}〜${size.maxSide} ピクセル）`;
  }
  return longer > shorter * size.maxRatio
    ? `大きさが ${actual} です（長い辺は短い辺の ${size.maxRatio} 倍まで）`
    : undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// PNG の色の種類のうち、アルファを持つもの（4: グレーとアルファ、6: RGB とアルファ）
const PNG_ALPHA_COLOR_TYPES = [4, 6];

type ParsedImage = { format: ImageFormat; width: number; height: number; hasAlpha: boolean };

function parseImage(bytes: Buffer): ParsedImage | undefined {
  if (bytes.length >= 26 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {
      format: 'png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      hasAlpha: PNG_ALPHA_COLOR_TYPES.includes(bytes[25] ?? -1),
    };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
    if (isStartOfFrame(bytes[offset + 1] ?? 0)) {
      return {
        format: 'jpeg',
        width: bytes.readUInt16BE(offset + 7),
        height: bytes.readUInt16BE(offset + 5),
        hasAlpha: false,
      };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

// SOF0〜SOF15 のうち、C4（ハフマンの表）・C8（予約）・CC（算術符号の表）は、大きさを持たない
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}
