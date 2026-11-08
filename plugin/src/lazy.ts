// 同時に呼ばれても1回だけ作る。Play が2つできると、まだ送っていない edit が分かれて失われる。
// 失敗は覚えない。鍵のファイルを置いたあとは、起動し直さなくても動く
export function once<T>(create: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= create().catch((error: unknown) => {
      value = undefined;
      throw error;
    });
    return value;
  };
}
