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
};

type Options = Partial<Snapshot> & {
  lifecycle?: Record<string, unknown[]>;
  failures?: Record<string, Response>;
  nextVersionCode?: number;
};

type Edit = { snapshot: Snapshot; invalidBecause?: string };

const PUBLISHER_ORIGIN = 'https://androidpublisher.googleapis.com';

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
  ...initial
}: Options = {}) {
  const live: Snapshot = {
    details: {},
    listings: [],
    tracks: { production: [] },
    bundles: [],
    apks: [],
    ...structuredClone(initial),
  };
  const edits = new Map<string, Edit>();
  let nextEdit = 1;
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
    const trackName = /^\/tracks\/(.+)$/.exec(tail)?.[1];
    if (trackName !== undefined && method === 'GET') {
      const releases = snapshot.tracks[trackName];
      return releases === undefined
        ? apiError(404, `Track ${trackName} not found.`, 'notFound')
        : jsonResponse(200, { track: trackName, releases });
    }
    if (trackName !== undefined && method === 'PUT') {
      const { releases } = JSON.parse(String(init?.body)) as { releases: FakeRelease[] };
      const statuses = releases.map(({ status }) => status);
      if (new Set(statuses).size !== statuses.length) {
        return apiError(400, 'Releases must have distinct statuses.');
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
