import { z } from 'zod';
import {
  appPath,
  GpcApiError,
  UnknownOutcomeError,
  type GpcClient,
  type Params,
} from './client.ts';
import { createMemoryStore, type PendingStore } from './pending-store.ts';

export const AppEdit = z.object({ id: z.string(), expiryTimeSeconds: z.string().optional() });

const GONE_REASONS = ['editExpired', 'editNotFound', 'editAlreadyCommitted', 'editDeleted'];

export type PendingSummary = { expiresAt: string | null; changes: string[] };

type Pending = PendingSummary & { id: string };

export type ReadableEdit = { path: string };

export type CommitOptions = {
  cancelChangesInReview?: boolean | undefined;
  notSentForReview?: boolean | undefined;
};

export type WritableEdit = ReadableEdit & {
  previousChanges: readonly string[];
  change<T>(description: string, work: () => Promise<T>): Promise<T>;
  finishChange(unfinished: string, finished: string): void;
  commit(options?: CommitOptions): Promise<void>;
  abandon(): Promise<readonly string[]>;
};

export type Edits = {
  read<T>(packageName: string, work: (edit: ReadableEdit) => Promise<T>): Promise<T>;
  write<T>(packageName: string, work: (edit: WritableEdit) => Promise<T>): Promise<T>;
  discard(packageName: string): Promise<PendingSummary | null>;
  pending(packageName: string): PendingSummary | null;
  writeFromOtherApp<S, T>(
    packageName: string,
    otherPackage: string,
    read: (edit: ReadableEdit) => Promise<S>,
    work: (edit: WritableEdit, value: S) => Promise<T>,
  ): Promise<T>;
};

export type Play = { client: GpcClient; edits: Edits };

export function createPlay(client: GpcClient, store: PendingStore = createMemoryStore()): Play {
  return { client, edits: createEdits(client, store) };
}

function createEdits(client: GpcClient, store: PendingStore): Edits {
  const pendings = new Map<string, Pending>();
  const unsaved = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();

  // 新しい edit を作ると、開いている edit は無効になる（Google の文書では、アプリでなく利用者につき1つ）。
  // Claude は同時に複数のツールを呼ぶので、呼び出しをアプリをまたいで順番に行う
  function inOrder<T>(packageName: string, job: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      await load(packageName);
      const before = JSON.stringify(pendings.get(packageName));
      try {
        return await job();
      } finally {
        if (JSON.stringify(pendings.get(packageName)) !== before) {
          await save(packageName);
        }
      }
    });
    queue = run.catch(() => undefined);
    return run;
  }

  // 別のセッションが足した変更を見落とさないよう、毎回読み直す。保存に失敗したアプリは、メモリのほうが新しい
  async function load(packageName: string): Promise<void> {
    if (unsaved.has(packageName)) {
      return;
    }
    const stored = await store.get(packageName);
    if (stored === undefined) {
      pendings.delete(packageName);
    } else {
      pendings.set(packageName, stored);
    }
  }

  async function save(packageName: string): Promise<void> {
    try {
      await store.put(packageName, pendings.get(packageName));
      unsaved.delete(packageName);
    } catch {
      unsaved.add(packageName);
    }
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

  async function readApp<T>(
    packageName: string,
    work: (edit: ReadableEdit) => Promise<T>,
  ): Promise<T> {
    const pending = await currentPending(packageName);
    if (pending !== undefined) {
      return guarded(packageName, pending, () => work({ path: pathOf(packageName, pending.id) }));
    }
    const temporary = await open(packageName);
    try {
      return await work({ path: pathOf(packageName, temporary.id) });
    } finally {
      await close(packageName, temporary.id);
    }
  }

  async function writeApp<T>(
    packageName: string,
    work: (edit: WritableEdit) => Promise<T>,
  ): Promise<T> {
    const pending = (await currentPending(packageName)) ?? (await open(packageName));
    pendings.set(packageName, pending);
    const path = pathOf(packageName, pending.id);
    const previousChanges = [...pending.changes];
    try {
      return await guarded(packageName, pending, () =>
        work({
          path,
          previousChanges,
          async change(description, step) {
            const uncertain = uncertainOf(description);
            const others = () =>
              pending.changes.filter((text) => text !== description && text !== uncertain);
            try {
              const result = await step();
              pending.changes = [...others(), description];
              return result;
            } catch (error) {
              // 記録しないと、捨てる変更の一覧から漏れ、何も変えていない edit として消してしまう
              if (mayHaveArrived(error) && !pending.changes.includes(description)) {
                pending.changes = [...others(), uncertain];
              }
              throw error;
            }
          },
          finishChange(unfinished, finished) {
            const stale = [unfinished, uncertainOf(unfinished)];
            if (pending.changes.some((text) => stale.includes(text))) {
              pending.changes = [
                ...pending.changes.filter((text) => !stale.includes(text) && text !== finished),
                finished,
              ];
            }
          },
          async commit(options = {}) {
            await commit(client, path, options);
            pendings.delete(packageName);
          },
          async abandon() {
            pendings.delete(packageName);
            await close(packageName, pending.id);
            return [...pending.changes];
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
  }

  return {
    read(packageName, work) {
      return inOrder(packageName, () => readApp(packageName, work));
    },

    write(packageName, work) {
      return inOrder(packageName, () => writeApp(packageName, work));
    },

    // 確かめて読んで書くまでを1回の順番で行う。あいだに別のツールが変更を足すと、別のアプリの edit で失われる
    writeFromOtherApp(packageName, otherPackage, read, work) {
      return inOrder(packageName, async () => {
        await load(otherPackage);
        const busy = [packageName, otherPackage].filter(
          (name) => (pendings.get(name)?.changes.length ?? 0) > 0,
        );
        if (busy.length > 0) {
          throw new Error(
            `${busy.join('・')} にまだ送っていない変更があるので、別のアプリから写せません（別のアプリの edit を作ると、変更が無効になることがあります）。先に送るか、discard_changes で捨ててください。`,
          );
        }
        const value = await readApp(otherPackage, read);
        return writeApp(packageName, (edit) => work(edit, value));
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

async function commit(client: GpcClient, path: string, options: CommitOptions): Promise<void> {
  const params: Params = {
    // 省くと、審査中の変更を取り下げてから送る。頼まれないかぎり、審査を止めない
    changesInReviewBehavior:
      options.cancelChangesInReview === true ? 'CANCEL_IN_REVIEW_AND_SUBMIT' : 'ERROR_IF_IN_REVIEW',
    ...(options.notSentForReview === true ? { changesNotSentForReview: 'true' } : {}),
  };
  try {
    await client.post(`${path}:commit`, params, undefined, AppEdit);
  } catch (error) {
    throw error instanceof GpcApiError ? withCommitHint(error) : error;
  }
}

function withCommitHint(error: GpcApiError): GpcApiError {
  const hint = commitHint(error);
  return hint === undefined
    ? error
    : new GpcApiError(error.status, `${hint}\n${error.message}`, error.reasons);
}

function commitHint(error: GpcApiError): string | undefined {
  if (error.reasons.includes('CHANGES_ALREADY_IN_REVIEW')) {
    return '審査中の変更があるので、送りませんでした。審査が終わるのを待つか、cancelChangesInReview: true で審査中の変更を取り下げて送ってください。';
  }
  if (error.message.includes('changesNotSentForReview to true')) {
    return 'このアプリの変更は、自動では審査に送れません（却下のあとなど）。notSentForReview: true で保存し、Play Console の [公開の概要] の [審査に送信] で送ってください。';
  }
  if (error.message.includes('changesNotSentForReview must not be set')) {
    return 'このアプリの変更は、自動で審査に送られます。notSentForReview を外してください。';
  }
  return undefined;
}

function uncertainOf(description: string): string {
  return `${description}（届いたかは分かりません）`;
}

function mayHaveArrived(error: unknown): boolean {
  return (
    error instanceof UnknownOutcomeError || (error instanceof GpcApiError && error.status >= 500)
  );
}

export function isGone(error: unknown): boolean {
  return (
    error instanceof GpcApiError && error.reasons.some((reason) => GONE_REASONS.includes(reason))
  );
}

function lostError(pending: Pending, cause: unknown): Error {
  return new Error(
    [
      'まだ送っていない変更が、Google Play で無効になりました（有効期限が切れた、Play Console で別の変更をした、別のアプリを操作した、ほかの場所で edit を作ったかコミットしたなど）。',
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
