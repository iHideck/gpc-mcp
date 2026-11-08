import { z } from 'zod';
import type { GpcClient } from './client.ts';
import type { PendingSummary, Play, WritableEdit } from './edits.ts';
import { listListings, Listing } from './localizations.ts';
import { trackProgress } from './progress.ts';
import { isDraft, readTrack, writeTrack, type Release, type Track } from './tracks.ts';

type FieldRule = { label: string; limit?: number; url?: true };

// 上限は Play Console ヘルプのもの。全角と半角を区別しない
const LISTING_FIELDS = {
  title: { label: 'タイトル', limit: 30 },
  shortDescription: { label: '簡単な説明', limit: 80 },
  fullDescription: { label: '詳しい説明', limit: 4000 },
  video: { label: '動画の URL', url: true },
} satisfies Record<string, FieldRule>;

type ListingField = keyof typeof LISTING_FIELDS;
const LISTING_FIELD_NAMES = Object.keys(LISTING_FIELDS) as ListingField[];
const REQUIRED_FOR_NEW_LOCALE: ListingField[] = ['title', 'shortDescription', 'fullDescription'];

const RELEASE_NOTES_LIMIT = 500;

function listingRule(name: ListingField): FieldRule {
  return LISTING_FIELDS[name];
}

const requiredText = (name: ListingField) =>
  z
    .string()
    .min(1)
    .optional()
    .describe(describeRule(listingRule(name), false));

export const localizationInput = z.object({
  locale: z
    .string()
    .min(1)
    .describe('言語のコード（例: ja-JP、en-US）。get_localizations で見られる'),
  title: requiredText('title'),
  shortDescription: requiredText('shortDescription'),
  fullDescription: requiredText('fullDescription'),
  video: z
    .string()
    .nullable()
    .optional()
    .describe(describeRule(listingRule('video'), true)),
  releaseNotes: z
    .string()
    .nullable()
    .optional()
    .describe(
      `トラックの下書きのリリースのリリースノート。${RELEASE_NOTES_LIMIT} 文字まで。null か空の文字にすると消す。省くと変えない`,
    ),
});

export type LocalizationInput = z.infer<typeof localizationInput>;

export type SetLocalizationsRequest = {
  packageName: string;
  track: string;
  localizations: LocalizationInput[];
};

type ChangedField = ListingField | 'releaseNotes';

export type LocalizationChange = {
  locale: string;
  field: ChangedField;
  before: string | null;
  after: string | null;
};

export type SetLocalizationsResult = {
  packageName: string;
  track: string;
  changes: LocalizationChange[];
  pending: PendingSummary | null;
  warnings: string[];
};

type ListingWrite = {
  locale: string;
  isNew: boolean;
  fields: ListingField[];
  body: Listing;
  before: Listing | undefined;
};

type NotesWrite = {
  draft: Release;
  changes: { locale: string; before: string | null; after: string | null }[];
  releaseNotes: { language: string; text: string }[];
};

export async function setLocalizations(
  { client, edits }: Play,
  { packageName, track, localizations }: SetLocalizationsRequest,
): Promise<SetLocalizationsResult> {
  checkTexts(localizations);
  return edits.write(packageName, async (edit) => {
    const needsTrack = localizations.some(({ releaseNotes }) => releaseNotes !== undefined);
    const [listings, current] = await Promise.all([
      listListings(client, edit),
      needsTrack ? readTrack(client, edit, track) : undefined,
    ]);
    const listingWrites = planListings(localizations, listings);
    const notesWrite = current === undefined ? undefined : planNotes(localizations, current);
    const changes: LocalizationChange[] = [];
    const warnings: string[] = [];
    const progress = trackProgress();
    for (const write of listingWrites) {
      const stored = await putListing(client, edit, write, progress);
      for (const field of write.fields) {
        const wanted = write.body[field] ?? null;
        const after = stored[field] ?? null;
        changes.push({
          locale: write.locale,
          field,
          before: write.before?.[field] ?? null,
          after,
        });
        if (after !== wanted) {
          warnings.push(differentValue(write.locale, LISTING_FIELDS[field].label));
        }
      }
      if (write.isNew) {
        warnings.push(`言語 ${write.locale} の掲載情報を新しく作りました。`);
      }
    }
    if (notesWrite !== undefined && notesWrite.changes.length > 0 && current !== undefined) {
      const stored = await putNotes(client, edit, track, current, notesWrite, progress);
      for (const { locale, before, after } of notesWrite.changes) {
        changes.push({ locale, field: 'releaseNotes', before, after });
        const saved = stored.releaseNotes?.find(({ language }) => language === locale)?.text;
        if ((saved ?? null) !== after) {
          warnings.push(differentValue(locale, 'リリースノート'));
        }
      }
    }
    return { packageName, track, changes, pending: edits.pending(packageName), warnings };
  });
}

function differentValue(locale: string, label: string): string {
  return `Google Play の値が、頼んだものと違います: ${locale} の${label}（Google が直したかもしれません。get_localizations で確かめてください）`;
}

async function putListing(
  client: GpcClient,
  edit: WritableEdit,
  { locale, fields, body }: ListingWrite,
  progress: ReturnType<typeof trackProgress>,
): Promise<Listing> {
  const labels = fields.map((field) => LISTING_FIELDS[field].label).join('・');
  const what = `${locale} の${labels}`;
  return progress.write(`${what}を変える`, `${what}を変えました`, () =>
    edit.change(`${what}を変えた`, () =>
      client.put(`${edit.path}/listings/${encodeURIComponent(locale)}`, body, Listing),
    ),
  );
}

async function putNotes(
  client: GpcClient,
  edit: WritableEdit,
  track: string,
  current: Track,
  { draft, changes, releaseNotes }: NotesWrite,
  progress: ReturnType<typeof trackProgress>,
): Promise<Release> {
  const what = `${changes.map(({ locale }) => locale).join('・')} のリリースノート`;
  const next = { ...draft, releaseNotes };
  const stored = await progress.write(`${what}を変える`, `${what}を変えました`, () =>
    edit.change(`${what}を変えた`, () =>
      writeTrack(
        client,
        edit,
        track,
        current.releases.map((release) => (isDraft(release) ? next : release)),
      ),
    ),
  );
  return stored.find(isDraft) ?? next;
}

function checkTexts(localizations: LocalizationInput[]): void {
  const locales = localizations.map(({ locale }) => locale);
  const repeated = [...new Set(locales.filter((locale, i) => locales.indexOf(locale) !== i))];
  const problems = repeated.map(
    (locale) => `言語 ${locale} が2回以上あります。1つにまとめてください`,
  );
  for (const entry of localizations) {
    for (const name of LISTING_FIELD_NAMES) {
      const value = entry[name];
      if (value === undefined || value === null || value === '') {
        continue;
      }
      problems.push(...fieldProblems(entry.locale, listingRule(name), value));
    }
    if (entry.releaseNotes !== undefined && entry.releaseNotes !== null) {
      problems.push(
        ...fieldProblems(
          entry.locale,
          { label: 'リリースノート', limit: RELEASE_NOTES_LIMIT },
          entry.releaseNotes,
        ),
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `入れる前に確かめたら、合わない所がありました。何も変えていません。\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
  }
}

function fieldProblems(locale: string, { label, limit, url }: FieldRule, value: string): string[] {
  const length = [...value].length;
  return [
    ...(limit !== undefined && length > limit
      ? [`${locale} の${label}: ${length} 文字（${limit} 文字まで）`]
      : []),
    ...(url === true && !isWebUrl(value)
      ? [`${locale} の${label}: http か https の URL ではありません`]
      : []),
  ];
}

function planListings(localizations: LocalizationInput[], listings: Listing[]): ListingWrite[] {
  const problems: string[] = [];
  const writes: ListingWrite[] = [];
  for (const entry of localizations) {
    const given = LISTING_FIELD_NAMES.filter((name) => entry[name] !== undefined);
    if (given.length === 0) {
      continue;
    }
    const before = listings.find(({ language }) => language === entry.locale);
    if (before === undefined) {
      const missing = REQUIRED_FOR_NEW_LOCALE.filter((name) => entry[name] === undefined);
      if (missing.length > 0) {
        problems.push(
          `言語 ${entry.locale} の掲載情報はありません。新しく作るには、${missing
            .map((name) => LISTING_FIELDS[name].label)
            .join(
              '・',
            )}も要ります。ある言語は ${listings.map(({ language }) => language).join('、')} です`,
        );
        continue;
      }
    }
    const next: Listing = { ...(before ?? {}), language: entry.locale };
    for (const name of given) {
      const value = entry[name] || undefined;
      if (value === undefined) {
        delete next[name];
      } else {
        next[name] = value;
      }
    }
    const fields = given.filter((name) => (next[name] ?? null) !== (before?.[name] ?? null));
    if (fields.length > 0) {
      writes.push({
        locale: entry.locale,
        isNew: before === undefined,
        fields,
        body: next,
        before,
      });
    }
  }
  if (problems.length > 0) {
    throw new Error(`${problems.join('。\n')}。\n何も変えていません。`);
  }
  return writes;
}

function planNotes(localizations: LocalizationInput[], current: Track): NotesWrite | undefined {
  const draft = current.releases.find(isDraft);
  if (draft === undefined) {
    throw new Error(
      `${current.track} に下書きのリリースがありません。select_build でビルドを選んでから、リリースノートを入れてください。何も変えていません。`,
    );
  }
  const notes = new Map((draft.releaseNotes ?? []).map(({ language, text }) => [language, text]));
  const changes: NotesWrite['changes'] = [];
  for (const { locale, releaseNotes } of localizations) {
    if (releaseNotes === undefined) {
      continue;
    }
    const before = notes.get(locale) ?? null;
    const after = releaseNotes === null || releaseNotes === '' ? null : releaseNotes;
    if (before !== after) {
      changes.push({ locale, before, after });
      if (after === null) {
        notes.delete(locale);
      } else {
        notes.set(locale, after);
      }
    }
  }
  return {
    draft,
    changes,
    releaseNotes: [...notes].map(([language, text]) => ({ language, text })),
  };
}

function isWebUrl(value: string): boolean {
  return URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);
}

function describeRule({ label, limit, url }: FieldRule, clearable: boolean): string {
  return [
    label,
    limit === undefined ? undefined : `${limit} 文字まで`,
    url === true ? 'http か https の URL' : undefined,
    clearable ? 'null か空の文字にすると消す' : undefined,
    '省くと変えない',
  ]
    .filter((part) => part !== undefined)
    .join('。');
}
