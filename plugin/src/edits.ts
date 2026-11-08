import { z } from 'zod';
import { appPath, type GpcClient } from './client.ts';

const AppEdit = z.object({ id: z.string() });

export type ReadableEdit = { path: string };

export type Edits = {
  read<T>(packageName: string, work: (edit: ReadableEdit) => Promise<T>): Promise<T>;
};

export type Play = { client: GpcClient; edits: Edits };

export function createPlay(client: GpcClient): Play {
  return { client, edits: createEdits(client) };
}

function createEdits(client: GpcClient): Edits {
  const queues = new Map<string, Promise<unknown>>();

  // 新しい edit を作ると、開いている edit は無効になる。同じアプリの呼び出しは、順番に行う
  function inOrder<T>(packageName: string, job: () => Promise<T>): Promise<T> {
    const run = (queues.get(packageName) ?? Promise.resolve()).then(job);
    queues.set(
      packageName,
      run.catch(() => undefined),
    );
    return run;
  }

  return {
    read(packageName, work) {
      return inOrder(packageName, async () => {
        const app = appPath(packageName);
        const edit = await client.post(`${app}/edits`, {}, {}, AppEdit);
        const path = `${app}/edits/${encodeURIComponent(edit.id)}`;
        try {
          return await work({ path });
        } finally {
          // 消せなくても、期限が切れるか、次の edit を作ると無効になる
          await client.remove(path).catch(() => undefined);
        }
      });
    },
  };
}
