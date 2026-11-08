import { z } from 'zod';
import type { GpcClient } from './client.ts';
import type { PendingSummary, Play, ReadableEdit } from './edits.ts';
import { isDraft, readTrack, viewOf, type Release, type ReleaseView } from './tracks.ts';

export const Listing = z.looseObject({
  language: z.string(),
  title: z.string().optional(),
  shortDescription: z.string().optional(),
  fullDescription: z.string().optional(),
  video: z.string().optional(),
});

export type Listing = z.infer<typeof Listing>;

const ListingList = z.object({ listings: z.array(Listing).optional() });

export const AppDetails = z.looseObject({
  defaultLanguage: z.string().optional(),
  contactEmail: z.string().optional(),
  contactPhone: z.string().optional(),
  contactWebsite: z.string().optional(),
});

export type AppDetails = z.infer<typeof AppDetails>;

export type LocalizationsRequest = { packageName: string; track: string; locales?: string[] };

type ListingText = {
  locale: string;
  title: string | null;
  shortDescription: string | null;
  fullDescription: string | null;
  video: string | null;
};

export type Localizations = {
  packageName: string;
  defaultLanguage: string | null;
  listings: ListingText[];
  releaseNotes: {
    track: string;
    release: ReleaseView;
    notes: { locale: string; text: string }[];
  } | null;
  pending: PendingSummary | null;
};

export async function listListings(client: GpcClient, edit: ReadableEdit): Promise<Listing[]> {
  const { listings } = await client.get(`${edit.path}/listings`, {}, ListingList);
  return listings ?? [];
}

export async function getLocalizations(
  { client, edits }: Play,
  { packageName, track, locales }: LocalizationsRequest,
): Promise<Localizations> {
  return edits.read(packageName, async (edit) => {
    const [listings, details, current] = await Promise.all([
      listListings(client, edit),
      client.get(`${edit.path}/details`, {}, AppDetails),
      readTrack(client, edit, track),
    ]);
    const release = current.releases.find(isDraft) ?? newest(current.releases);
    const notes = release?.releaseNotes ?? [];
    const known = new Set([
      ...listings.map(({ language }) => language),
      ...notes.map(({ language }) => language),
    ]);
    // 言語のコードを当て推量で渡されたとき（ja など）に、空の結果を「文が無い」と読み違えさせない
    const unknown = (locales ?? []).filter((locale) => !known.has(locale));
    if (unknown.length > 0) {
      throw new Error(
        `言語 ${unknown.join('、')} の文はありません。ある言語は ${[...known].join('、')} です。`,
      );
    }
    const wanted = (locale: string) => locales === undefined || locales.includes(locale);
    return {
      packageName,
      defaultLanguage: details.defaultLanguage ?? null,
      listings: listings.filter(({ language }) => wanted(language)).map(textOf),
      releaseNotes:
        release === undefined
          ? null
          : {
              track,
              release: viewOf(release),
              notes: notes
                .filter(({ language }) => wanted(language))
                .map(({ language, text }) => ({ locale: language, text })),
            },
      pending: edits.pending(packageName),
    };
  });
}

function newest(releases: Release[]): Release | undefined {
  return [...releases].sort((a, b) => highestCode(b) - highestCode(a))[0];
}

function highestCode({ versionCodes }: Release): number {
  return Math.max(0, ...(versionCodes ?? []).map(Number));
}

function textOf(listing: Listing): ListingText {
  return {
    locale: listing.language,
    title: listing.title ?? null,
    shortDescription: listing.shortDescription ?? null,
    fullDescription: listing.fullDescription ?? null,
    video: listing.video ?? null,
  };
}
