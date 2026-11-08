import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  createTokenSource,
  loadCredentials,
  signAssertion,
} from '../plugin/src/auth.ts';
import { fakeFetch, jsonResponse } from './fake-api.ts';

const CLIENT_EMAIL = 'release@example.iam.gserviceaccount.com';

async function emptyHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gpc-mcp-'));
}

function serviceAccountKey(overrides: object = {}): { json: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey,
    json: JSON.stringify({
      type: 'service_account',
      client_email: CLIENT_EMAIL,
      private_key_id: 'key-id',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      ...overrides,
    }),
  };
}

async function homeWithKey(content: string): Promise<{ home: string; path: string }> {
  const home = await emptyHome();
  const path = join(home, 'service-account.json');
  await writeFile(path, content);
  return { home, path };
}

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString());
}

describe('loadCredentials と signAssertion', () => {
  it('鍵で、Google のトークンの発行先が受け付ける形の JWT に署名する', async () => {
    const { json, publicKey } = serviceAccountKey();
    const { path } = await homeWithKey(json);
    const credentials = await loadCredentials({ GPC_SERVICE_ACCOUNT_KEY: path });

    const [header = '', payload = '', signature = ''] = signAssertion(
      credentials,
      1_700_000_000,
    ).split('.');

    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'key-id' });
    expect(decode(payload)).toEqual({
      iss: CLIENT_EMAIL,
      scope:
        'https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('~ で始まるパスは、ホームからのパスとして読む', async () => {
    const { home } = await homeWithKey(serviceAccountKey().json);

    await expect(
      loadCredentials({ GPC_SERVICE_ACCOUNT_KEY: '~/service-account.json' }, home),
    ).resolves.toMatchObject({ clientEmail: CLIENT_EMAIL });
  });

  it.each([
    ['無い', {}],
    ['空', { GPC_SERVICE_ACCOUNT_KEY: '' }],
    ['置き換えられていない', { GPC_SERVICE_ACCOUNT_KEY: '${user_config.service_account_key}' }],
    ['相対パス', { GPC_SERVICE_ACCOUNT_KEY: 'service-account.json' }],
  ])('鍵のファイルの設定が%sときは、設定の直し方を返す', async (_, env) => {
    const result = loadCredentials(env, await emptyHome());

    await expect(result).rejects.toThrow(ConfigError);
    await expect(result).rejects.toThrow('/plugin configure gpc-mcp@gpc-mcp');
  });

  it('鍵のファイルが無いときは、置く場所を返す', async () => {
    const path = join(await emptyHome(), 'missing.json');

    await expect(loadCredentials({ GPC_SERVICE_ACCOUNT_KEY: path })).rejects.toThrow(path);
  });

  it.each([
    ['JSON ではない', 'not json'],
    ['サービスアカウントの鍵ではない', JSON.stringify({ type: 'authorized_user' })],
    ['秘密鍵を読めない', serviceAccountKey({ private_key: 'not a key' }).json],
  ])('%sファイルは、受け付けない', async (_, content) => {
    const { path } = await homeWithKey(content);

    await expect(loadCredentials({ GPC_SERVICE_ACCOUNT_KEY: path })).rejects.toThrow(ConfigError);
  });
});

describe('createTokenSource', () => {
  async function credentials() {
    const { path } = await homeWithKey(serviceAccountKey().json);
    return loadCredentials({ GPC_SERVICE_ACCOUNT_KEY: path });
  }

  const issued = (value: string) =>
    jsonResponse(200, { access_token: value, expires_in: 3600, token_type: 'Bearer' });

  it('JWT をトークンに換え、有効期限の1分前までは同じトークンを返す', async () => {
    const fetchFn = fakeFetch({
      'POST /token': [issued('first'), issued('second')],
    });
    let now = 1_700_000_000;
    const token = createTokenSource(await credentials(), fetchFn, () => now);

    expect(await token()).toBe('first');
    now += 3600 - 61;
    expect(await token()).toBe('first');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(body.get('assertion')?.split('.')).toHaveLength(3);

    now += 2;
    expect(await token()).toBe('second');
  });

  it('Google が発行を断ったら、鍵を確かめるように返し、理由を添える', async () => {
    const fetchFn = fakeFetch({
      'POST /token': jsonResponse(400, {
        error: 'invalid_grant',
        error_description: 'Invalid JWT Signature.',
      }),
    });
    const result = createTokenSource(await credentials(), fetchFn)();

    await expect(result).rejects.toThrow(ConfigError);
    await expect(result).rejects.toThrow(/有効かを確かめて[\s\S]*Invalid JWT Signature/);
  });
});
