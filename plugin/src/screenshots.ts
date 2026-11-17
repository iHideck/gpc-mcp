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
  phoneScreenshots: screenshot('phone screenshots', 320, 3840),
  sevenInchScreenshots: screenshot('7-inch tablet screenshots', 320, 7680),
  tenInchScreenshots: screenshot('10-inch tablet screenshots', 320, 7680),
  tvScreenshots: screenshot('Android TV screenshots', 320, 3840),
  wearScreenshots: screenshot('Wear OS screenshots', 384, 3840),
  icon: {
    label: 'app icon',
    maxFiles: 1,
    formats: ['png'],
    size: { exact: '512x512' },
    maxBytes: 1024 * 1024,
    noAlpha: false,
  },
  featureGraphic: {
    label: 'feature graphic',
    maxFiles: 1,
    formats: ANY_FORMAT,
    size: { exact: '1024x500' },
    maxBytes: MAX_IMAGE_BYTES,
    noAlpha: true,
  },
  tvBanner: {
    label: 'Android TV banner',
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
          `${fileName} is a PNG with alpha. Google Play requires PNG images without alpha, so remove the alpha channel if Google Play rejects it.`,
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
    // 途中で止まると、前の画像が消えたまま送られることがある。止まったことが pending で分かるようにする
    const unfinished = `Started replacing the ${locale} ${imageType} (some images are missing)`;
    const finished = `Replaced the ${locale} ${imageType}`;
    if (sameImages(before, images)) {
      edit.finishChange(unfinished, finished);
      return result([], 0, before);
    }
    const progress = trackProgress();
    // 順番を変える API が無いので、入れ直して順番をそろえる
    if (before.length > 0) {
      await progress.write('removing the previous images', 'Removed the previous images', () =>
        edit.change(unfinished, () => client.remove(path)),
      );
    }
    for (const { fileName, bytes, contentType } of images) {
      await progress.write(`uploading ${fileName}`, `Uploaded ${fileName}`, () =>
        edit.change(unfinished, () => client.upload(path, { contentType, bytes }, ImageUpload)),
      );
    }
    edit.finishChange(unfinished, finished);
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
      `${imageType} (${rule.label}) accepts at most ${rule.maxFiles} image${rule.maxFiles === 1 ? '' : 's'}; ${paths.length} were passed. Nothing was changed.`,
    );
  }
  const checks = await Promise.all(paths.map((path) => checkFile(path, rule)));
  const problems = checks.flatMap((check, index) =>
    'problem' in check ? [`- ${paths[index]}: ${check.problem}`] : [],
  );
  if (problems.length > 0) {
    throw new Error(
      [
        `These images cannot be used as ${imageType} (${rule.label}), so nothing was changed.`,
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
    return { problem: 'Pass an absolute path' };
  }
  let bytes: Buffer<ArrayBuffer>;
  try {
    bytes = await readFile(path);
  } catch {
    return { problem: 'Cannot read the file' };
  }
  if (bytes.length > rule.maxBytes) {
    return { problem: `${bytes.length} bytes (limit ${rule.maxBytes} bytes)` };
  }
  const image = parseImage(bytes);
  if (image === undefined) {
    return { problem: 'Cannot read the size as a PNG or JPEG image' };
  }
  if (!rule.formats.includes(image.format)) {
    return { problem: `Pass a ${rule.formats.join(' or ').toUpperCase()} image` };
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
    return actual === size.exact ? undefined : `Size is ${actual} (must be ${size.exact})`;
  }
  const shorter = Math.min(width, height);
  const longer = Math.max(width, height);
  if (shorter < size.minSide || longer > size.maxSide) {
    return `Size is ${actual} (each side must be ${size.minSide} to ${size.maxSide} pixels)`;
  }
  return longer > shorter * size.maxRatio
    ? `Size is ${actual} (the long side must be at most ${size.maxRatio} times the short side)`
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
