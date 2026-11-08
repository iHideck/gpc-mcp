import { z } from 'zod';
import type { GpcClient } from './client.ts';
import type { ReadableEdit, WritableEdit } from './edits.ts';

export const DEFAULT_TRACK = 'production';

const LocalizedText = z.object({ language: z.string(), text: z.string() });

// 読んだリリースは、そのまま Google に送り返す。ツールが知らない項目（国の指定など）も落とさない
export const Release = z.looseObject({
  name: z.string().optional(),
  status: z.string(),
  versionCodes: z.array(z.string()).optional(),
  userFraction: z.number().optional(),
  releaseNotes: z.array(LocalizedText).optional(),
});

export type Release = z.infer<typeof Release>;

const TrackResource = z.object({ track: z.string(), releases: z.array(Release).optional() });
const TrackList = z.object({ tracks: z.array(TrackResource).optional() });

export type Track = { track: string; releases: Release[] };

export type ReleaseView = {
  name: string | null;
  status: string;
  versionCodes: string[];
  userFraction: number | null;
  releaseNotesLocales: string[];
};

export function viewOf(release: Release): ReleaseView {
  return {
    name: release.name ?? null,
    status: release.status,
    versionCodes: release.versionCodes ?? [],
    userFraction: release.userFraction ?? null,
    releaseNotesLocales: (release.releaseNotes ?? []).map(({ language }) => language),
  };
}

export function isDraft(release: Release): boolean {
  return release.status === 'draft';
}

export async function listTracks(client: GpcClient, edit: ReadableEdit): Promise<Track[]> {
  const { tracks } = await client.get(`${edit.path}/tracks`, {}, TrackList);
  return (tracks ?? []).map(({ track, releases }) => ({ track, releases: releases ?? [] }));
}

export async function readTrack(
  client: GpcClient,
  edit: ReadableEdit,
  name: string,
): Promise<Track> {
  const { track, releases } = await client.get(trackPath(edit, name), {}, TrackResource);
  return { track, releases: releases ?? [] };
}

// Google は、送らなかったリリースをトラックから外す。変えないリリースも送る
export async function writeTrack(
  client: GpcClient,
  edit: WritableEdit,
  name: string,
  releases: Release[],
): Promise<Release[]> {
  const updated = await client.put(trackPath(edit, name), { track: name, releases }, TrackResource);
  return updated.releases ?? [];
}

function trackPath(edit: ReadableEdit, name: string): string {
  return `${edit.path}/tracks/${encodeURIComponent(name)}`;
}
