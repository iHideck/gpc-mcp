import { describe, expect, it, vi } from 'vitest';
import { once } from '../plugin/src/lazy.ts';

describe('once', () => {
  it('同時に呼ばれても1回だけ作り、同じものを返す', async () => {
    const create = vi.fn(async () => ({}));
    const get = once(create);

    const [first, second] = await Promise.all([get(), get()]);

    expect(first).toBe(second);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('失敗は覚えず、次の呼び出しで作り直す', async () => {
    const create = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('まだ鍵が無い'))
      .mockResolvedValueOnce('play');
    const get = once(create);

    await expect(get()).rejects.toThrow('まだ鍵が無い');
    await expect(get()).resolves.toBe('play');
    await expect(get()).resolves.toBe('play');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
