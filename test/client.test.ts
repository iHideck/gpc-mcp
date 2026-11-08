import { describe, expect, it } from 'vitest';
import { createClient, isReadOnly } from '../plugin/src/client.ts';
import { AppEdit } from '../plugin/src/edits.ts';
import { fakeFetch, jsonResponse } from './fake-api.ts';

const APP = '/androidpublisher/v3/applications/com.example.app';
const token = async () => 'TOKEN';

describe('createClient', () => {
  it('書かない設定では、edit の中を変えるリクエストを送らない', async () => {
    const fetchFn = fakeFetch({});
    const client = createClient(token, fetchFn, true);

    await expect(
      client.post(
        `${APP}/edits/e1:commit`,
        { changesInReviewBehavior: 'ERROR_IF_IN_REVIEW' },
        undefined,
        AppEdit,
      ),
    ).rejects.toThrow(
      `送りませんでした: POST ${APP}/edits/e1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
    );
    await expect(client.remove(`${APP}/edits/e1/listings/ja-JP/icon`)).rejects.toThrow(
      `送りませんでした: DELETE ${APP}/edits/e1/listings/ja-JP/icon`,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('書かない設定でも、読むための edit は作って消す', async () => {
    const fetchFn = fakeFetch({
      [`POST ${APP}/edits`]: jsonResponse(200, { id: 'e1' }),
      [`DELETE ${APP}/edits/e1`]: new Response(null, { status: 204 }),
    });
    const client = createClient(token, fetchFn, true);

    await expect(client.post(`${APP}/edits`, {}, {}, AppEdit)).resolves.toEqual({ id: 'e1' });
    await expect(client.remove(`${APP}/edits/e1`)).resolves.toBeUndefined();
  });

  it('書かない設定は、値が無いか 0 のときだけ外す', () => {
    expect([undefined, '', '0'].map(isReadOnly)).toEqual([false, false, false]);
    expect(['1', 'true', 'yes'].map(isReadOnly)).toEqual([true, true, true]);
  });
});
