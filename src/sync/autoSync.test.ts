/**
 * 自动同步调度的测试
 *
 * 这块逻辑全是**时间**和**并发**，是那种"平时看着好好的、一到弱网或息屏就出问题"的代码。
 * 所以用假定时器把时间捏在手里测。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoSync, type SyncOutcome } from './autoSync';

const OK: SyncOutcome = { pushed: 1, pulled: 0, merged: 0 };

/** 造一个可控的调度器：sync 要手动 resolve */
function makeHarness(over: Partial<ConstructorParameters<typeof AutoSync>[0]> = {}) {
  const calls: string[] = [];
  let resolveNext: ((v: SyncOutcome) => void) | null = null;
  let rejectNext: ((e: unknown) => void) | null = null;

  const results: SyncOutcome[] = [];
  const errors: unknown[] = [];

  const auto = new AutoSync({
    sync: () => {
      calls.push('sync');
      return new Promise<SyncOutcome>((res, rej) => {
        resolveNext = res;
        rejectNext = rej;
      });
    },
    onResult: (o) => results.push(o),
    onError: (e) => errors.push(e),
    ...over,
  });

  return {
    auto,
    calls,
    results,
    errors,
    /** 让当前进行中的那次同步成功 */
    async succeed(outcome: SyncOutcome = OK) {
      resolveNext?.(outcome);
      await Promise.resolve();
      await Promise.resolve();
    },
    async fail(error: unknown) {
      rejectNext?.(error);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('心跳', () => {
  it('start 之后按间隔跑', async () => {
    const h = makeHarness({ intervalMs: 1000 });
    h.auto.start();
    expect(h.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(1);

    await h.succeed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);

    h.auto.stop();
  });

  it('stop 之后不再跑', async () => {
    const h = makeHarness({ intervalMs: 1000 });
    h.auto.start();
    h.auto.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(0);
    expect(h.auto.isRunning).toBe(false);
  });

  it('start 调两次不会装两个定时器', async () => {
    const h = makeHarness({ intervalMs: 1000 });
    h.auto.start();
    h.auto.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(1);

    h.auto.stop();
  });
});

describe('有新内容时', () => {
  it('★ 等 debounce 才跑 —— 连着写十笔只发一个请求', async () => {
    const h = makeHarness({ debounceMs: 1000 });
    h.auto.start();

    for (let i = 0; i < 10; i += 1) {
      h.auto.notifyChange();
      await vi.advanceTimersByTimeAsync(300); // 每次都在 debounce 之内
    }
    expect(h.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(1);

    h.auto.stop();
  });

  it('★ 反复 notifyChange 只是推迟，不会排队好几个', async () => {
    const h = makeHarness({ debounceMs: 1000 });
    h.auto.start();

    h.auto.notifyChange();
    await vi.advanceTimersByTimeAsync(900);
    h.auto.notifyChange(); // 推迟
    await vi.advanceTimersByTimeAsync(900);
    expect(h.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls).toHaveLength(1);

    // 而且只有一次
    await h.succeed();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(1);

    h.auto.stop();
  });

  it('没 start 时 notifyChange 不做事', async () => {
    const h = makeHarness({ debounceMs: 1000 });
    h.auto.notifyChange();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(0);
  });

  it('stop 会取消还没到点的 debounce', async () => {
    const h = makeHarness({ debounceMs: 1000 });
    h.auto.start();
    h.auto.notifyChange();
    h.auto.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(0);
  });
});

describe('不重入', () => {
  it('★ 上一轮没跑完时，心跳不会叠一个新的', async () => {
    const h = makeHarness({ intervalMs: 1000 });
    h.auto.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(1);

    // 故意不 resolve，让它在飞
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(1); // 还是只有那一次

    await h.succeed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);

    h.auto.stop();
  });

  it('跑完一轮之后才记 lastSyncAt', async () => {
    const h = makeHarness({ now: () => 12345 });
    expect(h.auto.lastSyncAt).toBeNull();

    const p = h.auto.runNow('测试');
    expect(h.auto.lastSyncAt).toBeNull(); // 还没完成

    await h.succeed();
    await p;
    expect(h.auto.lastSyncAt).toBe(12345);
  });
});

describe('失败', () => {
  it('★ 一次失败不会把自动同步永久关掉', async () => {
    const h = makeHarness({ intervalMs: 1000 });
    h.auto.start();

    await vi.advanceTimersByTimeAsync(1000);
    await h.fail(new Error('断网了'));
    expect(h.errors).toHaveLength(1);
    expect(h.auto.isRunning).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2); // 下一次照样跑

    h.auto.stop();
  });

  it('失败时不记 lastSyncAt（"上次同步"不该说谎）', async () => {
    const h = makeHarness({ now: () => 999 });
    const p = h.auto.runNow('测试');
    await h.fail(new Error('x'));
    await p;

    expect(h.auto.lastSyncAt).toBeNull();
    expect(h.results).toHaveLength(0);
  });

  it('shouldContinueAfterError 返回 false 时彻底停下', async () => {
    const h = makeHarness({
      intervalMs: 1000,
      shouldContinueAfterError: () => false,
    });
    h.auto.start();

    await vi.advanceTimersByTimeAsync(1000);
    await h.fail(new Error('没配服务端'));
    expect(h.auto.isRunning).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(1);
  });

  it('失败之后 inFlight 被清掉，不会永久卡住', async () => {
    const h = makeHarness({ intervalMs: 1000 });
    h.auto.start();

    await vi.advanceTimersByTimeAsync(1000);
    await h.fail(new Error('x'));

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);

    h.auto.stop();
  });
});

describe('结果回调', () => {
  it('成功时把结果报出去', async () => {
    const h = makeHarness();
    const outcome = { pushed: 3, pulled: 5, merged: 2 };
    const p = h.auto.runNow('测试');
    await h.succeed(outcome);
    await p;

    expect(h.results).toEqual([outcome]);
  });
});
