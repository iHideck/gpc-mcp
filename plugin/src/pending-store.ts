import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const StoredPending = z.object({
  id: z.string(),
  expiresAt: z.string().nullable(),
  changes: z.array(z.string()),
});
const StoredFile = z.record(z.string(), StoredPending);

export type StoredPending = z.infer<typeof StoredPending>;

export type PendingStore = {
  get(packageName: string): Promise<StoredPending | undefined>;
  put(packageName: string, pending: StoredPending | undefined): Promise<void>;
};

export function createMemoryStore(): PendingStore {
  const entries = new Map<string, StoredPending>();
  return {
    get: async (packageName) => entries.get(packageName),
    put: async (packageName, pending) => {
      if (pending === undefined) {
        entries.delete(packageName);
      } else {
        entries.set(packageName, pending);
      }
    },
  };
}

// アプリごとに書き足すので、同時に動く別のセッションのアプリの記録を消さない
export function createFileStore(path: string): PendingStore {
  async function read(): Promise<Record<string, StoredPending>> {
    try {
      return StoredFile.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      return {};
    }
  }
  return {
    async get(packageName) {
      return (await read())[packageName];
    },
    async put(packageName, pending) {
      const entries = await read();
      if (pending === undefined) {
        delete entries[packageName];
      } else {
        entries[packageName] = pending;
      }
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}
