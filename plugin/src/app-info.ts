import type { PendingSummary, Play, WritableEdit } from './edits.ts';
import { AppDetails } from './localizations.ts';

const FIELDS = ['defaultLanguage', 'contactEmail', 'contactPhone', 'contactWebsite'] as const;
type Field = (typeof FIELDS)[number];
const CONTACT_FIELDS = ['contactEmail', 'contactPhone', 'contactWebsite'] as const;

export type SetAppInfoRequest = {
  packageName: string;
  defaultLanguage?: string | undefined;
  contactEmail?: string | undefined;
  contactPhone?: string | null | undefined;
  contactWebsite?: string | null | undefined;
  sameAsApp?: string | undefined;
};

type AppInfo = Record<Field, string | null>;

export type SetAppInfoResult = {
  packageName: string;
  before: AppInfo;
  after: AppInfo;
  missingInSource: string[];
  pending: PendingSummary | null;
};

export async function setAppInfo(
  { client, edits }: Play,
  request: SetAppInfoRequest,
): Promise<SetAppInfoResult> {
  const { packageName, sameAsApp } = request;
  checkWebsite(request.contactWebsite);
  if (sameAsApp === packageName) {
    throw new Error('sameAsApp には、別のアプリのパッケージ名を渡してください。');
  }

  async function apply(edit: WritableEdit, source: AppDetails | undefined) {
    const wanted = { ...request };
    for (const field of CONTACT_FIELDS) {
      if (wanted[field] === undefined) {
        wanted[field] = source?.[field];
      }
    }
    const missingInSource = CONTACT_FIELDS.filter(
      (field) =>
        source !== undefined && request[field] === undefined && source[field] === undefined,
    );
    const path = `${edit.path}/details`;
    const current = await client.get(path, {}, AppDetails);
    const next: AppDetails = { ...current };
    for (const field of FIELDS) {
      const value = wanted[field];
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
    const stored =
      changed.length === 0
        ? current
        : await edit.change(`App の情報（${changed.join('・')}）を変えた`, () =>
            client.put(path, next, AppDetails),
          );
    return {
      packageName,
      before: infoOf(current),
      after: infoOf(stored),
      missingInSource,
      pending: edits.pending(packageName),
    };
  }

  return sameAsApp === undefined
    ? edits.write(packageName, (edit) => apply(edit, undefined))
    : edits.writeFromOtherApp(
        packageName,
        sameAsApp,
        (edit) => client.get(`${edit.path}/details`, {}, AppDetails),
        apply,
      );
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
