import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { assertInSpec, jsonResponse, request } from './fake-api.ts';

export type FakeRelease = {
  name?: string;
  status: string;
  versionCodes?: string[];
  userFraction?: number;
  releaseNotes?: { language: string; text: string }[];
  [key: string]: unknown;
};

export type FakeListing = {
  language: string;
  title?: string;
  shortDescription?: string;
  fullDescription?: string;
  video?: string;
};

type Snapshot = {
  details: Record<string, string>;
  listings: FakeListing[];
  tracks: Record<string, FakeRelease[]>;
  bundles: { versionCode: number; sha256: string; sha1: string }[];
  apks: { versionCode: number; binary: { sha256: string; sha1: string } }[];
  testers: Record<string, string[]>;
  // 「言語/種類」の名前で持つ
  images: Record<string, { id: string; sha256: string; sha1: string; url: string }[]>;
};

type Options = Partial<Snapshot> & {
  lifecycle?: Record<string, unknown[]>;
  failures?: Record<string, Response>;
  nextVersionCode?: number;
  availability?: Record<string, unknown>;
  // 審査中の変更がある
  inReview?: boolean;
  // true なら Google が自動で審査に送る状態。false なら却下のあとなどで、手動で送る状態
  autoReview?: boolean;
  // まだ公開していないアプリ
  draftApp?: boolean;
  // 全員に出したリリースの前にも、全員に出したリリースがある（止めるのに要る）
  hasPreviousFullRelease?: boolean;
};

type Edit = { snapshot: Snapshot; invalidBecause?: string };

const PUBLISHER_ORIGIN = 'https://androidpublisher.googleapis.com';

function sentForReview(before: Snapshot, after: Snapshot): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const hasNewRelease = (track: string) =>
    !/(^|:)(internal|qa)$/.test(track) &&
    (after.tracks[track] ?? []).some(
      ({ status, versionCodes }) =>
        status !== 'draft' &&
        !(before.tracks[track] ?? []).some(
          (previous) => previous.status !== 'draft' && same(previous.versionCodes, versionCodes),
        ),
    );
  return (
    !same(before.details, after.details) ||
    !same(before.listings, after.listings) ||
    !same(before.images, after.images) ||
    Object.keys(after.tracks).some(hasNewRelease)
  );
}

export function apiError(status: number, message: string, reason?: string): Response {
  return jsonResponse(status, {
    error: {
      code: status,
      message,
      status: 'FAILED_PRECONDITION',
      ...(reason === undefined
        ? {}
        : { errors: [{ domain: 'androidpublisher', reason, message }] }),
    },
  });
}

// Google の文書どおりに edit を扱う偽の Google Play。送ったリクエストは、毎回、API の仕様と照らす
export function fakePlay({
  lifecycle = {},
  failures = {},
  nextVersionCode = 100,
  availability = {},
  inReview = false,
  autoReview = true,
  draftApp = false,
  hasPreviousFullRelease = false,
  ...initial
}: Options = {}) {
  const live: Snapshot = {
    details: {},
    listings: [],
    tracks: { production: [] },
    bundles: [],
    apks: [],
    images: {},
    testers: {},
    ...structuredClone(initial),
  };
  const edits = new Map<string, Edit>();
  let nextEdit = 1;
  let dataSafety: string | undefined;
  let nextImage = 1;
  const failing = new Map(Object.entries(failures));

  function invalidateAll(reason: string): void {
    for (const edit of edits.values()) {
      edit.invalidBecause ??= reason;
    }
  }

  function openEdit(id: string): Edit | Response {
    const edit = edits.get(id);
    if (edit === undefined) {
      return apiError(404, 'Edit not found.', 'editNotFound');
    }
    if (edit.invalidBecause !== undefined) {
      return apiError(400, 'This Edit has been deleted.', edit.invalidBecause);
    }
    return edit;
  }

  function handle(method: string, url: URL, init: RequestInit | undefined): Response {
    const path = decodeURIComponent(url.pathname).replace(/^\/upload/, '');
    const app = /^\/androidpublisher\/v3\/applications\/[^/]+/.exec(path)?.[0];
    if (app === undefined) {
      throw new Error(`偽の Google Play が受け付けないパスです: ${path}`);
    }
    const rest = path.slice(app.length);
    if (method === 'GET' && /^\/tracks\/[^/]+\/releases$/.test(rest)) {
      const track = rest.split('/')[2] ?? '';
      return jsonResponse(200, { releases: lifecycle[track] ?? [] });
    }
    if (method === 'POST' && rest === '/dataSafety') {
      const { safetyLabels } = JSON.parse(String(init?.body)) as { safetyLabels: string };
      dataSafety = safetyLabels;
      return jsonResponse(200, {});
    }
    if (method === 'POST' && rest === '/edits') {
      invalidateAll('editExpired');
      const id = `edit-${nextEdit++}`;
      edits.set(id, { snapshot: structuredClone(live) });
      return jsonResponse(200, { id, expiryTimeSeconds: '1800000000' });
    }
    const match = /^\/edits\/([^/:]+)(.*)$/.exec(rest);
    if (match === null) {
      throw new Error(`偽の Google Play が受け付けないパスです: ${path}`);
    }
    const [, id = '', tail = ''] = match;
    const edit = openEdit(id);
    if (edit instanceof Response) {
      return edit;
    }
    const { snapshot } = edit;
    const route = `${method} ${tail}`;
    if (route === 'GET ') {
      return jsonResponse(200, { id, expiryTimeSeconds: '1800000000' });
    }
    if (route === 'DELETE ') {
      edits.delete(id);
      return new Response(null, { status: 204 });
    }
    if (route === 'GET /details') {
      return jsonResponse(200, snapshot.details);
    }
    if (route === 'GET /listings') {
      return jsonResponse(200, { listings: snapshot.listings });
    }
    if (route === 'GET /bundles') {
      return jsonResponse(200, { bundles: snapshot.bundles });
    }
    if (route === 'GET /apks') {
      return jsonResponse(200, { apks: snapshot.apks });
    }
    if (route === 'GET /tracks') {
      return jsonResponse(200, {
        tracks: Object.entries(snapshot.tracks).map(([track, releases]) => ({ track, releases })),
      });
    }
    if (method === 'POST' && tail === ':validate') {
      return jsonResponse(200, { id, expiryTimeSeconds: '1800000000' });
    }
    if (method === 'POST' && tail === ':commit') {
      const behavior = url.searchParams.get('changesInReviewBehavior');
      const notSent = url.searchParams.get('changesNotSentForReview') === 'true';
      if (inReview && behavior !== 'CANCEL_IN_REVIEW_AND_SUBMIT') {
        return jsonResponse(400, {
          error: {
            code: 400,
            message: 'You already have changes in review.',
            status: 'FAILED_PRECONDITION',
            details: [{ reason: 'CHANGES_ALREADY_IN_REVIEW' }],
          },
        });
      }
      if (!autoReview && !notSent) {
        return apiError(
          400,
          'Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.',
        );
      }
      if (autoReview && notSent) {
        return apiError(
          400,
          'Changes are sent for review automatically. The query parameter changesNotSentForReview must not be set.',
        );
      }
      // 送った変更は審査中になる（内部テストと、下書きだけの変更は除く）
      inReview = !notSent && sentForReview(live, snapshot);
      Object.assign(live, snapshot);
      invalidateAll('editExpired');
      edit.invalidBecause = 'editAlreadyCommitted';
      return jsonResponse(200, { id, expiryTimeSeconds: '1800000000' });
    }
    if (route === 'PUT /details') {
      snapshot.details = JSON.parse(String(init?.body)) as Snapshot['details'];
      return jsonResponse(200, snapshot.details);
    }
    const imageTarget = /^\/listings\/([^/]+)\/([^/]+)$/.exec(tail);
    if (imageTarget !== null) {
      const [, language = '', imageType = ''] = imageTarget;
      if (!snapshot.listings.some((listing) => listing.language === language)) {
        return apiError(404, `Listing ${language} not found.`, 'notFound');
      }
      const key = `${language}/${imageType}`;
      if (method === 'GET') {
        return jsonResponse(200, { images: snapshot.images[key] ?? [] });
      }
      if (method === 'DELETE') {
        const deleted = snapshot.images[key] ?? [];
        snapshot.images[key] = [];
        return jsonResponse(200, { deleted });
      }
      const bytes = init?.body as Uint8Array<ArrayBuffer>;
      const image = {
        id: `image-${nextImage++}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sha1: createHash('sha1').update(bytes).digest('hex'),
        url: 'https://example.com/image',
      };
      snapshot.images[key] = [...(snapshot.images[key] ?? []), image];
      return jsonResponse(200, { image });
    }
    const listingLanguage = /^\/listings\/([^/]+)$/.exec(tail)?.[1];
    if (listingLanguage !== undefined && method === 'PUT') {
      const listing = JSON.parse(String(init?.body)) as FakeListing;
      snapshot.listings = [
        ...snapshot.listings.filter(({ language }) => language !== listingLanguage),
        listing,
      ];
      return jsonResponse(200, listing);
    }
    const testersTrack = /^\/testers\/(.+)$/.exec(tail)?.[1];
    if (testersTrack !== undefined && method === 'GET') {
      const googleGroups = snapshot.testers[testersTrack];
      return jsonResponse(200, googleGroups === undefined ? {} : { googleGroups });
    }
    if (testersTrack !== undefined && method === 'PUT') {
      const { googleGroups } = JSON.parse(String(init?.body)) as { googleGroups: string[] };
      snapshot.testers[testersTrack] = googleGroups;
      return jsonResponse(200, { googleGroups });
    }
    const availabilityTrack = /^\/countryAvailability\/(.+)$/.exec(tail)?.[1];
    if (availabilityTrack !== undefined && method === 'GET') {
      return jsonResponse(200, availability[availabilityTrack] ?? {});
    }
    if (route === 'POST /bundles') {
      const bytes = init?.body as Uint8Array<ArrayBuffer>;
      const bundle = {
        versionCode: nextVersionCode++,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sha1: createHash('sha1').update(bytes).digest('hex'),
      };
      snapshot.bundles.push(bundle);
      return jsonResponse(200, bundle);
    }
    if (route === 'POST /tracks') {
      const { track } = JSON.parse(String(init?.body)) as { track: string };
      snapshot.tracks[track] = [];
      return jsonResponse(200, { track, releases: [] });
    }
    const trackName = /^\/tracks\/(.+)$/.exec(tail)?.[1];
    if (trackName !== undefined && method === 'GET') {
      // リリースが無いトラックは、無いトラックと同じ 404 になる（fastlane と Gradle Play Publisher が前提にしている）
      const releases = snapshot.tracks[trackName] ?? [];
      return releases.length === 0
        ? apiError(404, 'Track not found.', 'notFound')
        : jsonResponse(200, { track: trackName, releases });
    }
    if (trackName !== undefined && method === 'PUT') {
      const { releases } = JSON.parse(String(init?.body)) as { releases: FakeRelease[] };
      const statuses = releases.map(({ status }) => status);
      if (new Set(statuses).size !== statuses.length) {
        return apiError(400, 'Releases must have distinct statuses.');
      }
      const haltsFullRelease = releases.some(
        ({ status, versionCodes }) =>
          status === 'halted' &&
          (snapshot.tracks[trackName] ?? []).some(
            (previous) =>
              previous.status === 'completed' &&
              JSON.stringify(previous.versionCodes) === JSON.stringify(versionCodes),
          ),
      );
      if (haltsFullRelease && !hasPreviousFullRelease) {
        return apiError(400, 'A release can only be halted if a previous release is available.');
      }
      if (draftApp && statuses.some((status) => status !== 'draft')) {
        return apiError(403, 'Only releases with status draft may be created on draft app.');
      }
      snapshot.tracks[trackName] = releases;
      return jsonResponse(200, { track: trackName, releases });
    }
    throw new Error(`偽の Google Play が受け付けないリクエストです: ${method} ${path}`);
  }

  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const { method, url, body } = request(input, init);
    assertInSpec(method, url, body);
    if (url.origin !== PUBLISHER_ORIGIN) {
      throw new Error(`偽の Google Play が受け付けないオリジンです: ${url.origin}`);
    }
    const key = `${method} ${decodeURIComponent(url.pathname)}`;
    const failure = failing.get(key);
    if (failure !== undefined) {
      failing.delete(key);
      return failure;
    }
    return handle(method, url, init);
  });

  return {
    fetch: fetchFn,
    live,
    dataSafety: () => dataSafety,
    openEdits: () => [...edits.entries()].filter(([, edit]) => edit.invalidBecause === undefined),
    snapshotOf: (id: string) => edits.get(id)?.snapshot,
    changeInConsole: () => invalidateAll('editDeleted'),
    requests: () =>
      fetchFn.mock.calls.map(([input, init]) => {
        const { method, url } = request(input, init);
        return `${method} ${decodeURIComponent(url.pathname)}`;
      }),
  };
}
