import { describe, expect, it } from 'vitest';
import { listApps } from '../plugin/src/apps.ts';
import { createClient, GpcApiError } from '../plugin/src/client.ts';
import { fakeFetch, jsonResponse, requestedUrls } from './fake-api.ts';

const token = async () => 'TOKEN';

describe('listApps', () => {
  it('全部のページを読み、パッケージ名の順に返す', async () => {
    const fetchFn = fakeFetch({
      '/v1beta1/apps:search': [
        jsonResponse(200, {
          apps: [
            { name: 'apps/2', packageName: 'com.example.b', displayName: 'B' },
            { name: 'apps/3', packageName: 'com.example.c' },
          ],
          nextPageToken: 'next',
        }),
        jsonResponse(200, {
          apps: [{ name: 'apps/1', packageName: 'com.example.a', displayName: 'A' }],
        }),
      ],
    });

    expect(await listApps(createClient(token, fetchFn))).toEqual([
      { name: 'A', packageName: 'com.example.a' },
      { name: 'B', packageName: 'com.example.b' },
      { name: null, packageName: 'com.example.c' },
    ]);
    expect(requestedUrls(fetchFn).map(({ search }) => search)).toEqual([
      '?pageSize=1000',
      '?pageSize=1000&pageToken=next',
    ]);
  });

  it('アプリが無いときは、空の一覧を返す', async () => {
    const fetchFn = fakeFetch({ '/v1beta1/apps:search': jsonResponse(200, {}) });

    expect(await listApps(createClient(token, fetchFn))).toEqual([]);
  });

  it('送るトークンは、トークンの発行元から受け取ったもの', async () => {
    const fetchFn = fakeFetch({ '/v1beta1/apps:search': jsonResponse(200, {}) });

    await listApps(createClient(token, fetchFn));

    expect(fetchFn.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer TOKEN' });
  });
});

describe('Google の API のエラー', () => {
  const failing = (status: number, error: object) =>
    createClient(token, fakeFetch({ '/v1beta1/apps:search': jsonResponse(status, { error }) }));

  it('API を有効にしていないときは、有効にする URL を返す', async () => {
    const client = failing(403, {
      code: 403,
      message: 'Google Play Developer Reporting API has not been used in project 1',
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'SERVICE_DISABLED',
          metadata: { activationUrl: 'https://console.developers.google.com/apis/api/x' },
        },
      ],
    });

    await expect(listApps(client)).rejects.toThrow(
      /API を有効にしてください。https:\/\/console\.developers\.google\.com\/apis\/api\/x/,
    );
  });

  it('権限が無いときは、Play Console で権限を与えるように返す', async () => {
    const client = failing(403, {
      code: 403,
      message: 'The caller does not have permission',
      status: 'PERMISSION_DENIED',
    });

    await expect(listApps(client)).rejects.toThrow(/ユーザーと権限[\s\S]*does not have permission/);
  });

  it('エラーの理由を、古い形と新しい形のどちらからも読む', async () => {
    const client = failing(400, {
      code: 400,
      message: 'edit',
      details: [{ reason: 'CHANGES_ALREADY_IN_REVIEW' }],
      errors: [{ reason: 'editExpired' }],
    });

    const error = await listApps(client).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GpcApiError);
    expect((error as GpcApiError).reasons).toEqual(['CHANGES_ALREADY_IN_REVIEW', 'editExpired']);
  });

  it('本文が JSON でなくても、状態のコードを返す', async () => {
    const fetchFn = fakeFetch({
      '/v1beta1/apps:search': new Response('Bad Gateway', { status: 502 }),
    });

    await expect(listApps(createClient(token, fetchFn))).rejects.toThrow('502');
  });

  it('接続できないときは、理由を返す', async () => {
    const fetchFn = fakeFetch({});
    fetchFn.mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }),
    );

    await expect(listApps(createClient(token, fetchFn))).rejects.toThrow('ENOTFOUND');
  });
});
