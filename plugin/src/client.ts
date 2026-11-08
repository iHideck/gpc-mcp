import { z } from 'zod';

const PUBLISHER_ORIGIN = 'https://androidpublisher.googleapis.com';
const REPORTING_ORIGIN = 'https://playdeveloperreporting.googleapis.com';
const TIMEOUT_MS = 30_000;
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

export type Params = Record<string, string>;

type Method = 'GET' | 'POST' | 'DELETE';

export type GpcClient = {
  get<T>(path: string, params: Params, schema: z.ZodType<T>): Promise<T>;
  post<T>(path: string, params: Params, body: object | undefined, schema: z.ZodType<T>): Promise<T>;
  remove(path: string): Promise<void>;
  getReporting<T>(path: string, params: Params, schema: z.ZodType<T>): Promise<T>;
};

export function appPath(packageName: string): string {
  return `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
}

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

const HINTS: Partial<Record<number, string>> = {
  401: 'サービスアカウントの鍵が Google Cloud で有効かを確かめてください。',
  403: 'サービスアカウントに、この操作の権限がありません。Play Console の「ユーザーと権限」で、サービスアカウントにアプリの権限を与えてください。',
  429: '呼び出しの上限に達しました。しばらく待ってから、やり直してください。',
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
  async function call(method: Method, url: URL, body?: object): Promise<unknown> {
    if (readOnly && method !== 'GET' && !EDIT_HOUSEKEEPING.test(url.pathname)) {
      throw new Error(
        `書かない設定で動いているので、次のリクエストを送りませんでした: ${method} ${url.pathname}${url.search}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`,
      );
    }
    const authorization = `Bearer ${await token()}`;
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          Authorization: authorization,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Google Play の API に接続できませんでした（${reasonOf(error)}）。`, {
        cause: error,
      });
    }
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw apiError(response.status, parsed);
    }
    return parsed;
  }

  return {
    async get(path, params, schema) {
      return parse(schema, await call('GET', urlOf(PUBLISHER_ORIGIN, path, params)), path);
    },
    async post(path, params, body, schema) {
      return parse(schema, await call('POST', urlOf(PUBLISHER_ORIGIN, path, params), body), path);
    },
    async remove(path) {
      await call('DELETE', urlOf(PUBLISHER_ORIGIN, path, {}));
    },
    async getReporting(path, params, schema) {
      return parse(schema, await call('GET', urlOf(REPORTING_ORIGIN, path, params)), path);
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
      `Google Play の API の ${path} の応答が、思っていた形と違います。\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function reasonOf(error: unknown, timeoutMs = TIMEOUT_MS): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === 'TimeoutError') {
    return `${timeoutMs / 1000}秒たっても応答がありません`;
  }
  // fetch は、DNS や TLS の失敗を cause に入れ、message は「fetch failed」だけにする
  return error.cause instanceof Error ? error.cause.message : error.message;
}

function apiError(status: number, body: unknown): GpcApiError {
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
      : `Google Cloud のプロジェクトで、この API を有効にしてください。${disabled.metadata?.activationUrl ?? ''}`;
  const message = [`Google Play の API が ${status} を返しました。`, hint, error?.message]
    .filter((line) => line !== undefined)
    .join('\n');
  return new GpcApiError(status, message, reasons);
}
