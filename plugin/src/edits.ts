import { z } from 'zod';
import { appPath, GpcApiError, type GpcClient } from './client.ts';

export const AppEdit = z.object({ id: z.string(), expiryTimeSeconds: z.string().optional() });

// edit が無効になったとき、Google が返す理由
const GONE_REASONS = ['editExpired', 'editNotFound', 'editAlreadyCommitted', 'editDeleted'];

export type PendingSummary = { expiresAt: string | null; changes: string[] };

type Pending = PendingSummary & { id: string };

export type ReadableEdit = { path: string };

export type WritableEdit = ReadableEdit & { recordChange(change: string): void };

export type Edits = {
  read<T>(packageName: string, work: (edit: ReadableEdit) => Promise<T>): Promise<T>;
  write<T>(packageName: string, work: (edit: WritableEdit) => Promise<T>): Promise<T>;
  discard(packageName: string): Promise<PendingSummary | null>;
  pending(packageName: string): PendingSummary | null;
};

export type Play = { client: GpcClient; edits: Edits };

export function createPlay(client: GpcClient): Play {
  return { client, edits: createEdits(client) };
}

function createEdits(client: GpcClient): Edits {
  const pendings = new Map<string, Pending>();
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

  const pathOf = (packageName: string, id: string) =>
    `${appPath(packageName)}/edits/${encodeURIComponent(id)}`;

  async function open(packageName: string): Promise<Pending> {
    try {
      const edit = await client.post(`${appPath(packageName)}/edits`, {}, {}, AppEdit);
      return { id: edit.id, expiresAt: isoOf(edit.expiryTimeSeconds), changes: [] };
    } catch (error) {
      throw error instanceof GpcApiError && error.status === 404
        ? new GpcApiError(
            404,
            `${packageName} のアプリは Google Play にありません。パッケージ名を確かめてください。ビルドを1つも上げていないアプリは API で扱えないので、Play Console で最初の App Bundle を上げてください。\n${error.message}`,
            error.reasons,
          )
        : error;
    }
  }

  // 消せなくても、期限が切れるか、次の edit を作ると無効になる
  async function close(packageName: string, id: string): Promise<void> {
    await client.remove(pathOf(packageName, id)).catch(() => undefined);
  }

  async function currentPending(packageName: string): Promise<Pending | undefined> {
    const pending = pendings.get(packageName);
    if (pending === undefined) {
      return undefined;
    }
    try {
      await client.get(pathOf(packageName, pending.id), {}, AppEdit);
    } catch (error) {
      if (isGone(error) || (error instanceof GpcApiError && error.status === 404)) {
        pendings.delete(packageName);
        throw lostError(pending, error);
      }
      throw error;
    }
    return pending;
  }

  async function guarded<T>(
    packageName: string,
    pending: Pending,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isGone(error)) {
        pendings.delete(packageName);
        throw lostError(pending, error);
      }
      throw error;
    }
  }

  return {
    read(packageName, work) {
      return inOrder(packageName, async () => {
        const pending = await currentPending(packageName);
        if (pending !== undefined) {
          return guarded(packageName, pending, () =>
            work({ path: pathOf(packageName, pending.id) }),
          );
        }
        const temporary = await open(packageName);
        try {
          return await work({ path: pathOf(packageName, temporary.id) });
        } finally {
          await close(packageName, temporary.id);
        }
      });
    },

    write(packageName, work) {
      return inOrder(packageName, async () => {
        const pending = (await currentPending(packageName)) ?? (await open(packageName));
        pendings.set(packageName, pending);
        try {
          return await guarded(packageName, pending, () =>
            work({
              path: pathOf(packageName, pending.id),
              recordChange(change) {
                pending.changes.push(change);
              },
            }),
          );
        } finally {
          // 何も変えなかった edit を残すと、まだ送っていない変更があるように見える
          if (pending.changes.length === 0 && pendings.has(packageName)) {
            pendings.delete(packageName);
            await close(packageName, pending.id);
          }
        }
      });
    },

    discard(packageName) {
      return inOrder(packageName, async () => {
        const pending = pendings.get(packageName);
        if (pending === undefined) {
          return null;
        }
        pendings.delete(packageName);
        await close(packageName, pending.id);
        return summaryOf(pending);
      });
    },

    pending(packageName) {
      const pending = pendings.get(packageName);
      return pending === undefined || pending.changes.length === 0 ? null : summaryOf(pending);
    },
  };
}

function isGone(error: unknown): error is GpcApiError {
  return (
    error instanceof GpcApiError && error.reasons.some((reason) => GONE_REASONS.includes(reason))
  );
}

function lostError(pending: Pending, cause: unknown): Error {
  return new Error(
    [
      'まだ送っていない変更が、Google Play で無効になりました（有効期限が切れた、Play Console で別の変更をした、ほかの場所で edit を作ったかコミットしたなど）。',
      ...(pending.changes.length === 0 ? [] : [`失われた変更: ${pending.changes.join('、')}。`]),
      '必要なら入れ直してください。前の呼び出しで送っている途中だったなら、送り終えているかもしれません。get_release_status で確かめてください。',
    ].join('\n'),
    { cause },
  );
}

function summaryOf({ expiresAt, changes }: Pending): PendingSummary {
  return { expiresAt, changes: [...changes] };
}

function isoOf(seconds: string | undefined): string | null {
  return seconds === undefined ? null : new Date(Number(seconds) * 1000).toISOString();
}
