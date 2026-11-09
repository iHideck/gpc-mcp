import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const StoredPending = z.object({
  id: z.string(),
  expiresAt: z.string().nullable(),
  changes: z.array(z.string()),
});

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

// アプリごとに別のファイルにする。同時に動くセッションや、1つのファイルの破損が、ほかのアプリの記録に及ばない
export function createFileStore(directory: string): PendingStore {
  const pathOf = (packageName: string) =>
    join(directory, `${encodeURIComponent(packageName)}.json`);
  return {
    async get(packageName) {
      try {
        return StoredPending.parse(JSON.parse(await readFile(pathOf(packageName), 'utf8')));
      } catch {
        return undefined;
      }
    },
    async put(packageName, pending) {
      const path = pathOf(packageName);
      if (pending === undefined) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(pending, null, 2), { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}
