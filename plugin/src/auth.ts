import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { reasonOf } from './client.ts';

export type Credentials = {
  clientEmail: string;
  privateKeyId: string;
  privateKey: KeyObject;
};

export type Token = { value: string; expiresAt: number };

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const SETUP_HINT =
  '/plugin configure gpc-mcp@gpc-mcp でサービスアカウントの鍵のファイルを入れてから、Claude Code を起動し直してください。';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/androidpublisher',
  'https://www.googleapis.com/auth/playdeveloperreporting',
];
// Google は、有効期限が1時間より先のトークンを発行しない
const TOKEN_LIFETIME_SECONDS = 60 * 60;
const REFRESH_BEFORE_SECONDS = 60;
const TIMEOUT_MS = 30_000;

const ServiceAccountKey = z.object({
  type: z.literal('service_account'),
  client_email: z.string().min(1),
  private_key_id: z.string().min(1),
  private_key: z.string().min(1),
});

const TokenResponse = z.object({ access_token: z.string(), expires_in: z.number() });
const TokenError = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export async function loadCredentials(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): Promise<Credentials> {
  const configured = env.GPC_SERVICE_ACCOUNT_KEY;
  if (configured === undefined || configured === '' || configured.includes('${')) {
    throw new ConfigError(`サービスアカウントの鍵のファイルが、設定されていません。${SETUP_HINT}`);
  }
  const path = expandHome(configured, home);
  if (!isAbsolute(path)) {
    throw new ConfigError(`鍵のファイルは、絶対パスで入れてください: ${configured}。${SETUP_HINT}`);
  }

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(
      `鍵のファイル ${path} を読めません。Google Cloud でダウンロードした JSON 鍵のファイルを、このパスに置いてください。`,
    );
  }
  const key = ServiceAccountKey.safeParse(parseJson(text));
  if (!key.success) {
    throw new ConfigError(
      `${path} を、サービスアカウントの JSON 鍵として読めません。Google Cloud でダウンロードしたファイルかを確かめてください。`,
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(key.data.private_key);
  } catch {
    throw new ConfigError(
      `${path} の秘密鍵を読めません。Google Cloud でダウンロードしたファイルかを確かめてください。`,
    );
  }
  return {
    clientEmail: key.data.client_email,
    privateKeyId: key.data.private_key_id,
    privateKey,
  };
}

function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function signAssertion(credentials: Credentials, issuedAt: number): string {
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: credentials.privateKeyId });
  const payload = encode({
    iss: credentials.clientEmail,
    scope: SCOPES.join(' '),
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), credentials.privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

function encode(part: object): string {
  return Buffer.from(JSON.stringify(part)).toString('base64url');
}

async function requestToken(
  credentials: Credentials,
  fetchFn: typeof fetch,
  issuedAt: number,
): Promise<Token> {
  let response: Response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signAssertion(credentials, issuedAt),
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Google のトークンの発行先に接続できませんでした（${reasonOf(error)}）。`, {
      cause: error,
    });
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const { error, error_description: description } = TokenError.safeParse(body).data ?? {};
    throw new ConfigError(
      [
        `Google がトークンを発行しませんでした（${response.status}）。サービスアカウントと鍵が Google Cloud で有効かを確かめてください。`,
        [error, description].filter(Boolean).join(': '),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  const token = TokenResponse.safeParse(body);
  if (!token.success) {
    throw new Error('Google のトークンの応答が、思っていた形と違います。');
  }
  return { value: token.data.access_token, expiresAt: issuedAt + token.data.expires_in };
}

export function createTokenSource(
  credentials: Credentials,
  fetchFn: typeof fetch = fetch,
  now: () => number = () => Math.floor(Date.now() / 1000),
): () => Promise<string> {
  let token: Token | undefined;
  return async () => {
    const current = now();
    if (token === undefined || token.expiresAt - current < REFRESH_BEFORE_SECONDS) {
      token = await requestToken(credentials, fetchFn, current);
    }
    return token.value;
  };
}
