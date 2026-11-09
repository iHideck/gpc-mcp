import { z } from 'zod';
import type { GpcClient } from './client.ts';
import type { PendingSummary, Play, ReadableEdit } from './edits.ts';

const Testers = z.object({ googleGroups: z.array(z.string()).optional() });

export type TestersRequest = { packageName: string; track: string };

export type TestersResult = {
  packageName: string;
  track: string;
  googleGroups: string[];
  pending: PendingSummary | null;
};

export type SetTestersRequest = TestersRequest & { googleGroups: string[] };

export type SetTestersResult = {
  packageName: string;
  track: string;
  before: string[];
  after: string[];
  pending: PendingSummary | null;
};

function testersPath(edit: ReadableEdit, track: string): string {
  return `${edit.path}/testers/${encodeURIComponent(track)}`;
}

async function readGroups(client: GpcClient, edit: ReadableEdit, track: string): Promise<string[]> {
  const { googleGroups } = await client.get(testersPath(edit, track), {}, Testers);
  return googleGroups ?? [];
}

export async function getTesters(
  { client, edits }: Play,
  { packageName, track }: TestersRequest,
): Promise<TestersResult> {
  return edits.read(packageName, async (edit) => ({
    packageName,
    track,
    googleGroups: await readGroups(client, edit, track),
    pending: edits.pending(packageName),
  }));
}

export async function setTesters(
  { client, edits }: Play,
  { packageName, track, googleGroups }: SetTestersRequest,
): Promise<SetTestersResult> {
  const wanted = [...new Set(googleGroups)];
  return edits.write(packageName, async (edit) => {
    const before = await readGroups(client, edit, track);
    const same = before.length === wanted.length && before.every((g) => wanted.includes(g));
    const after = same
      ? before
      : ((
          await edit.change(`${track} のテスターの Google グループを変えた`, () =>
            client.put(testersPath(edit, track), { googleGroups: wanted }, Testers),
          )
        ).googleGroups ?? []);
    return { packageName, track, before, after, pending: edits.pending(packageName) };
  });
}
