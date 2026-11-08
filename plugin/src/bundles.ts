import { z } from 'zod';
import type { GpcClient } from './client.ts';
import type { ReadableEdit } from './edits.ts';

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
