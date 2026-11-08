import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { GpcClient } from './client.ts';
import type { PendingSummary, Play, ReadableEdit } from './edits.ts';

const Bundle = z.object({ versionCode: z.number(), sha256: z.string().nullish() });
const BundleList = z.object({ bundles: z.array(Bundle).optional() });
const Apk = z.object({
  versionCode: z.number(),
  binary: z.object({ sha256: z.string().nullish() }).nullish(),
});
const ApkList = z.object({ apks: z.array(Apk).optional() });

export type Build = { versionCode: number; kind: 'bundle' | 'apk'; sha256: string | null };

// 新しいビルド（versionCode の大きいもの）から順に返す
export async function listBuilds(client: GpcClient, edit: ReadableEdit): Promise<Build[]> {
  const [{ bundles }, { apks }] = await Promise.all([
    client.get(`${edit.path}/bundles`, {}, BundleList),
    client.get(`${edit.path}/apks`, {}, ApkList),
  ]);
  return [
    ...(bundles ?? []).map(({ versionCode, sha256 }): Build => ({
      versionCode,
      kind: 'bundle',
      sha256: sha256 ?? null,
    })),
    ...(apks ?? []).map(({ versionCode, binary }): Build => ({
      versionCode,
      kind: 'apk',
      sha256: binary?.sha256 ?? null,
    })),
  ].sort((a, b) => b.versionCode - a.versionCode);
}

export type UploadBundleRequest = { packageName: string; file: string };

export type UploadedBundle = {
  packageName: string;
  versionCode: number;
  uploaded: boolean;
  pending: PendingSummary | null;
};

export async function uploadBundle(
  { client, edits }: Play,
  { packageName, file }: UploadBundleRequest,
): Promise<UploadedBundle> {
  const bytes = await readBundle(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return edits.write(packageName, async (edit) => {
    const existing = (await listBuilds(client, edit)).find((build) => build.sha256 === sha256);
    const versionCode =
      existing?.versionCode ??
      (
        await client.upload(
          `${edit.path}/bundles`,
          { contentType: 'application/octet-stream', bytes },
          Bundle,
        )
      ).versionCode;
    if (existing === undefined) {
      edit.recordChange(`App Bundle ${versionCode} を上げた`);
    }
    return {
      packageName,
      versionCode,
      uploaded: existing === undefined,
      pending: edits.pending(packageName),
    };
  });
}

async function readBundle(file: string): Promise<Buffer<ArrayBuffer>> {
  if (!isAbsolute(file)) {
    throw new Error(`App Bundle は、絶対パスで渡してください: ${file}`);
  }
  if (!file.endsWith('.aab')) {
    throw new Error(`App Bundle（.aab）のファイルを渡してください: ${file}`);
  }
  try {
    return await readFile(file);
  } catch (error) {
    throw new Error(`App Bundle のファイル ${file} を読めません。`, { cause: error });
  }
}
