import type { PendingSummary, Play } from './edits.ts';
import { AppDetails } from './localizations.ts';

const FIELDS = ['defaultLanguage', 'contactEmail', 'contactPhone', 'contactWebsite'] as const;
type Field = (typeof FIELDS)[number];

export type SetAppInfoRequest = {
  packageName: string;
  defaultLanguage?: string | undefined;
  contactEmail?: string | undefined;
  contactPhone?: string | null | undefined;
  contactWebsite?: string | null | undefined;
};

type AppInfo = Record<Field, string | null>;

export type SetAppInfoResult = {
  packageName: string;
  before: AppInfo;
  after: AppInfo;
  pending: PendingSummary | null;
};

export async function setAppInfo(
  { client, edits }: Play,
  request: SetAppInfoRequest,
): Promise<SetAppInfoResult> {
  const { packageName } = request;
  checkWebsite(request.contactWebsite);
  return edits.write(packageName, async (edit) => {
    const path = `${edit.path}/details`;
    const current = await client.get(path, {}, AppDetails);
    const next: AppDetails = { ...current };
    for (const field of FIELDS) {
      const value = request[field];
      if (value === undefined) {
        continue;
      }
      if (value === null || value === '') {
        delete next[field];
      } else {
        next[field] = value;
      }
    }
    const changed = FIELDS.filter((field) => (next[field] ?? null) !== (current[field] ?? null));
    if (changed.length === 0) {
      return {
        packageName,
        before: infoOf(current),
        after: infoOf(current),
        pending: edits.pending(packageName),
      };
    }
    const stored = await edit.change(`App の情報（${changed.join('・')}）を変えた`, () =>
      client.put(path, next, AppDetails),
    );
    return {
      packageName,
      before: infoOf(current),
      after: infoOf(stored),
      pending: edits.pending(packageName),
    };
  });
}

function infoOf(details: AppDetails): AppInfo {
  return {
    defaultLanguage: details.defaultLanguage ?? null,
    contactEmail: details.contactEmail ?? null,
    contactPhone: details.contactPhone ?? null,
    contactWebsite: details.contactWebsite ?? null,
  };
}

function checkWebsite(website: string | null | undefined): void {
  if (website === undefined || website === null || website === '') {
    return;
  }
  if (!URL.canParse(website) || !['http:', 'https:'].includes(new URL(website).protocol)) {
    throw new Error('ウェブサイトが、http か https の URL ではありません。何も変えていません。');
  }
}
