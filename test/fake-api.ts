import { vi } from 'vitest';

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
    const url = new URL(input instanceof Request ? input.url : input);
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    const response = queues.get(route)?.shift();
    if (response === undefined) {
      throw new Error(`応答を用意していないリクエストです: ${route}${url.search}`);
    }
    return response;
  });
}

export function requestedUrls(fetchFn: ReturnType<typeof fakeFetch>): URL[] {
  return fetchFn.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input));
}
