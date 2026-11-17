import { z } from 'zod';

const PUBLISHER_ORIGIN = 'https://androidpublisher.googleapis.com';
const REPORTING_ORIGIN = 'https://playdeveloperreporting.googleapis.com';
const TIMEOUT_MS = 30_000;
// App Bundle は数百 MB になることがある。回線が遅くても送り終えられるだけ待つ
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
// edit を作る・消すだけでは、アプリは変わらない。読むツールは edit の中で読むので、書かない設定でも通す
const EDIT_HOUSEKEEPING = /^\/androidpublisher\/v3\/applications\/[^/]+\/edits(\/[^/:]+)?$/;

export class GpcApiError extends Error {
  override name = 'GpcApiError';
  readonly status: number;
  readonly reasons: readonly string[];

  constructor(status: number, message: string, reasons: readonly string[] = []) {
    super(message);
    this.status = status;
    this.reasons = reasons;
  }
}

// Google に届いたかどうかが分からない失敗（応答が返らない・応答を読めない）
export class UnknownOutcomeError extends Error {
  override name = 'UnknownOutcomeError';
}

export type Params = Record<string, string>;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type Media = { contentType: string; bytes: Uint8Array<ArrayBuffer> };

export type GpcClient = {
  get<T>(path: string, params: Params, schema: z.ZodType<T>): Promise<T>;
  post<T>(path: string, params: Params, body: object | undefined, schema: z.ZodType<T>): Promise<T>;
  put<T>(path: string, body: object, schema: z.ZodType<T>): Promise<T>;
  remove(path: string): Promise<void>;
  upload<T>(path: string, media: Media, schema: z.ZodType<T>): Promise<T>;
  getReporting<T>(path: string, params: Params, schema: z.ZodType<T>): Promise<T>;
};

export function appPath(packageName: string): string {
  return `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
}

type Content = {
  type: string;
  payload: string | Uint8Array<ArrayBuffer>;
  summary: string;
  timeoutMs?: number;
};

const ErrorBody = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    // 新しい形（google.rpc.ErrorInfo）の理由は details に、古い形の理由は errors に入る
    details: z
      .array(
        z.object({
          reason: z.string().optional(),
          metadata: z.record(z.string(), z.string()).optional(),
        }),
      )
      .optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

// 書くツールは、いまの状態を読んでから差だけを変えるので、やり直しても二重には変えない
const RETRY_HINT = 'Retry the same call to continue from the current state.';
const WRITE_UNKNOWN_HINT = `It is unknown whether the change reached Google Play. ${RETRY_HINT}`;

const HINTS: Partial<Record<number, string>> = {
  401: 'Check that the service account key is valid in Google Cloud.',
  403: 'The service account has no permission for this operation. In Play Console, go to Users and permissions and grant the service account permissions for the app.',
  429: 'The request quota was reached. Wait a while, then retry.',
};

// 書かない設定は、値が無いか 0 のときだけ外す。打ち間違い（true など）で、本番に書いてしまわないため
export function isReadOnly(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0';
}

export function createClient(
  token: () => Promise<string>,
  fetchFn: typeof fetch = fetch,
  readOnly = false,
): GpcClient {
  async function send(method: Method, url: URL, content?: Content): Promise<unknown> {
    if (readOnly && method !== 'GET' && !EDIT_HOUSEKEEPING.test(url.pathname)) {
      throw new Error(
        `Read-only mode is on, so this request was not sent: ${method} ${url.pathname}${url.search}${content === undefined ? '' : ` ${content.summary}`}`,
      );
    }
    const timeoutMs = content?.timeoutMs ?? TIMEOUT_MS;
    const authorization = `Bearer ${await token()}`;
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          Authorization: authorization,
          ...(content === undefined ? {} : { 'Content-Type': content.type }),
        },
        body: content?.payload ?? null,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new UnknownOutcomeError(
        `Cannot connect to the Google Play API (${reasonOf(error, timeoutMs)}).${method === 'GET' ? '' : ` ${WRITE_UNKNOWN_HINT}`}`,
        { cause: error },
      );
    }
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw apiError(
        response.status,
        parsed,
        method !== 'GET' && response.status >= 500 ? WRITE_UNKNOWN_HINT : undefined,
      );
    }
    return parsed;
  }

  function json(body: object): Content {
    const payload = JSON.stringify(body);
    return { type: 'application/json', payload, summary: payload };
  }

  return {
    async get(path, params, schema) {
      return parse(schema, await send('GET', urlOf(PUBLISHER_ORIGIN, path, params)), path);
    },
    async post(path, params, body, schema) {
      const url = urlOf(PUBLISHER_ORIGIN, path, params);
      return parseWritten(schema, await send('POST', url, body && json(body)), path);
    },
    async put(path, body, schema) {
      const url = urlOf(PUBLISHER_ORIGIN, path, {});
      return parseWritten(schema, await send('PUT', url, json(body)), path);
    },
    async remove(path) {
      await send('DELETE', urlOf(PUBLISHER_ORIGIN, path, {}));
    },
    async upload(path, { contentType, bytes }, schema) {
      const url = urlOf(PUBLISHER_ORIGIN, `/upload${path}`, { uploadType: 'media' });
      return parseWritten(
        schema,
        await send('POST', url, {
          type: contentType,
          payload: bytes,
          summary: `(${bytes.length} bytes)`,
          timeoutMs: UPLOAD_TIMEOUT_MS,
        }),
        path,
      );
    },
    async getReporting(path, params, schema) {
      return parse(schema, await send('GET', urlOf(REPORTING_ORIGIN, path, params)), path);
    },
  };
}

function urlOf(origin: string, path: string, params: Params): URL {
  const url = new URL(path, origin);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `The response of ${path} from the Google Play API has an unexpected shape.\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

function parseWritten<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new UnknownOutcomeError(
      `The response of ${path} from the Google Play API has an unexpected shape. ${WRITE_UNKNOWN_HINT}`,
    );
  }
  return result.data;
}

export function reasonOf(error: unknown, timeoutMs = TIMEOUT_MS): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === 'TimeoutError') {
    return `no response in ${timeoutMs / 1000} seconds`;
  }
  // fetch は、DNS や TLS の失敗を cause に入れ、message は「fetch failed」だけにする
  return error.cause instanceof Error ? error.cause.message : error.message;
}

function apiError(status: number, body: unknown, suffix?: string): GpcApiError {
  const error = ErrorBody.safeParse(body).data?.error;
  const details = error?.details ?? [];
  const reasons = [...details, ...(error?.errors ?? [])].flatMap(({ reason }) =>
    reason === undefined ? [] : [reason],
  );
  // API を有効にしていないときの 403 は、サービスアカウントの権限とは直し方が違う
  const disabled = details.find(({ reason }) => reason === 'SERVICE_DISABLED');
  const hint =
    disabled === undefined
      ? HINTS[status]
      : `Enable this API in your Google Cloud project. ${disabled.metadata?.activationUrl ?? ''}`.trim();
  const message = [`The Google Play API returned ${status}.`, hint, error?.message, suffix]
    .filter((line) => line !== undefined)
    .join('\n');
  return new GpcApiError(status, message, reasons);
}
