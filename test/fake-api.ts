import { vi } from 'vitest';
import { specViolations, type Method } from './discovery.ts';

const TOKEN_ORIGIN = 'https://oauth2.googleapis.com';

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// 応答は「パス」（GET）か「メソッド パス」の名前で用意する
export function fakeFetch(routes: Record<string, Response | Response[]>) {
  const queues = new Map(
    Object.entries(routes).map(([route, responses]) => [
      route.includes(' ') ? route : `GET ${route}`,
      Array.isArray(responses) ? [...responses] : [responses],
    ]),
  );
  return vi.fn<typeof fetch>(async (input, init) => {
    const { method, url, body } = request(input, init);
    assertInSpec(method, url, body);
    const route = `${method} ${url.pathname}`;
    const response = queues.get(route)?.shift();
    if (response === undefined) {
      throw new Error(`応答を用意していないリクエストです: ${route}${url.search}`);
    }
    return response;
  });
}

export function requestedUrls(fetchFn: ReturnType<typeof fakeFetch>): URL[] {
  return fetchFn.mock.calls.map(([input, init]) => request(input, init).url);
}

export function assertInSpec(method: Method, url: URL, body: unknown): void {
  // トークンの発行先は Discovery の仕様の外にある
  const violations = url.origin === TOKEN_ORIGIN ? [] : specViolations(method, url, body);
  if (violations.length > 0) {
    throw new Error(`API の仕様と違うリクエストです。${violations.join('。')}`);
  }
}

export function request(input: string | URL | Request, init: RequestInit | undefined) {
  return {
    method: (init?.method ?? 'GET') as Method,
    url: new URL(input instanceof Request ? input.url : input),
    body: jsonBody(init),
  };
}

function jsonBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string' || !init.body.startsWith('{')) {
    return undefined;
  }
  return JSON.parse(init.body);
}
