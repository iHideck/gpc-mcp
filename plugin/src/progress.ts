import { GpcApiError } from './client.ts';

export type Progress = {
  write<T>(doing: string, done: string, work: () => Promise<T>): Promise<T>;
};

// 書くツールは、いまの状態を読んでから差だけを変えるので、やり直すと残りだけを行う
export function trackProgress(): Progress {
  const finished: string[] = [];
  return {
    async write(doing, done, work) {
      try {
        const result = await work();
        finished.push(done);
        return result;
      } catch (error) {
        if (finished.length === 0) {
          throw error;
        }
        const retry = isRequestProblem(error)
          ? 'Fix the error, then retry the same call to do only the rest'
          : 'Retry the same call to do only the rest';
        throw new Error(
          `${finished.join('. ')}. Stopped while ${doing}. ${retry}.\n${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
  };
}

// 4xx は、頼んだ中身か、Google Play の状態に足りない所がある。429（呼び出しの上限）は、待てば通る
function isRequestProblem(error: unknown): boolean {
  return (
    error instanceof GpcApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}
