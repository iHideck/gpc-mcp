// npm のパッケージ（tgz）を npx で起動し、MCP の tools/list に list_apps が出るかを確かめる
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const tarball = process.argv[2];
if (tarball === undefined) {
  console.error('使い方: node dev/check-npx.ts <tgz のパス>');
  process.exit(2);
}

// 前に入れた同じ版を npx が使い回さないよう、空のキャッシュで入れる
const cache = mkdtempSync(join(tmpdir(), 'gpc-mcp-npx-'));
const server = spawn('npx', ['-y', '--package', resolve(tarball), 'gpc-mcp'], {
  env: { ...process.env, GPC_SERVICE_ACCOUNT_KEY: '', npm_config_cache: cache },
  stdio: ['pipe', 'pipe', 'inherit'],
});

function finish(code: number, message: string): never {
  console.error(message);
  server.kill();
  rmSync(cache, { recursive: true, force: true });
  process.exit(code);
}

setTimeout(() => finish(1, 'npx で起動したサーバーが、120 秒たっても応答しません'), 120_000);
server.on('exit', (code) => finish(1, `npx で起動したサーバーが終わりました（${code}）`));

for (const message of [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'check-npx', version: '0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
]) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

for await (const line of createInterface({ input: server.stdout })) {
  const response = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
  if (response.id !== 2) {
    continue;
  }
  const names = (response.result?.tools ?? []).map(({ name }) => name);
  if (!names.includes('list_apps')) {
    finish(1, `tools/list に list_apps がありません: ${names.join(', ')}`);
  }
  finish(0, `npx で起動し、${names.length} 個のツールが tools/list に出ました`);
}
