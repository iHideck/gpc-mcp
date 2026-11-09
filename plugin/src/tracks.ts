import { z } from 'zod';
import { GpcApiError, type GpcClient } from './client.ts';
import {
  isGone,
  type PendingSummary,
  type Play,
  type ReadableEdit,
  type WritableEdit,
} from './edits.ts';

export const DEFAULT_TRACK = 'production';

const LocalizedText = z.object({ language: z.string(), text: z.string() });

// 読んだリリースは、そのまま Google に送り返す。ツールが知らない項目（国の指定など）も落とさない
export const Release = z.looseObject({
  name: z.string().optional(),
  status: z.string().default('statusUnspecified'),
  versionCodes: z.array(z.string()).optional(),
  userFraction: z.number().optional(),
  releaseNotes: z.array(LocalizedText).optional(),
  countryTargeting: z
    .object({
      countries: z.array(z.string()).optional(),
      includeRestOfWorld: z.boolean().optional(),
    })
    .optional(),
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
  countryTargeting: { countries: string[]; includeRestOfWorld: boolean } | null;
};

export function viewOf(release: Release): ReleaseView {
  return {
    name: release.name ?? null,
    status: release.status,
    versionCodes: release.versionCodes ?? [],
    userFraction: release.userFraction ?? null,
    releaseNotesLocales: (release.releaseNotes ?? []).map(({ language }) => language),
    countryTargeting:
      release.countryTargeting === undefined
        ? null
        : {
            countries: release.countryTargeting.countries ?? [],
            includeRestOfWorld: release.countryTargeting.includeRestOfWorld ?? false,
          },
  };
}

export function isDraft(release: Release): boolean {
  return release.status === 'draft';
}

export function isRollout(release: Release): boolean {
  return release.status === 'inProgress' || release.status === 'halted';
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
  try {
    const { track, releases } = await client.get(trackPath(edit, name), {}, TrackResource);
    return { track, releases: releases ?? [] };
  } catch (error) {
    // リリースがまだ無いトラックは、Google が 404 を返す。無効になった edit の 404 とは分ける
    if (error instanceof GpcApiError && error.status === 404 && !isGone(error)) {
      return { track: name, releases: [] };
    }
    throw error;
  }
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

// Google の仕様では、名前の接頭辞と formFactor が一致していなければならない
const FORM_FACTOR_OF_PREFIX: Partial<Record<string, string>> = {
  wear: 'WEAR',
  automotive: 'AUTOMOTIVE',
};

export type CreateTrackRequest = { packageName: string; track: string };

export type CreatedTrack = {
  packageName: string;
  track: string;
  created: boolean;
  pending: PendingSummary | null;
};

export async function createTrack(
  { client, edits }: Play,
  { packageName, track }: CreateTrackRequest,
): Promise<CreatedTrack> {
  const formFactor = formFactorOf(track);
  return edits.write(packageName, async (edit) => {
    const exists = (await listTracks(client, edit)).some(({ track: name }) => name === track);
    if (!exists) {
      await edit.change(`クローズドテストのトラック ${track} を作った`, () =>
        client.post(
          `${edit.path}/tracks`,
          {},
          { track, type: 'CLOSED_TESTING', formFactor },
          TrackResource,
        ),
      );
    }
    return { packageName, track, created: !exists, pending: edits.pending(packageName) };
  });
}

function formFactorOf(track: string): string {
  const separator = track.indexOf(':');
  if (separator === -1) {
    return 'DEFAULT';
  }
  const prefix = track.slice(0, separator);
  const formFactor = FORM_FACTOR_OF_PREFIX[prefix];
  if (formFactor === undefined) {
    throw new Error(
      `トラックの名前の接頭辞 ${prefix}: には、対応していません。クローズドテストのトラックを作れるのは、接頭辞なし（電話）・wear:・automotive: だけです。`,
    );
  }
  return formFactor;
}

function trackPath(edit: ReadableEdit, name: string): string {
  return `${edit.path}/tracks/${encodeURIComponent(name)}`;
}
