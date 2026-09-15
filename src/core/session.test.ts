/**
 * 会话边界判定的测试
 *
 * 这块逻辑的特点是：**平时看不出问题，出问题时很难发现**。
 * 阈值判错一点，表现为"一次学习被切成好几段"或者"两次学习粘成一次"，
 * 而这要过好几天才会被人注意到。
 *
 * 好在它是个纯函数，测起来几乎没有成本。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IDLE_MS,
  resolveSession,
  sessionDuration,
  type SessionContext,
  type SessionRecord,
} from './session';

const MINUTE = 60 * 1000;

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's-old',
    userId: 'local',
    title: null,
    startedAt: 1_000_000,
    endedAt: null,
    lastActive: 1_000_000,
    deviceId: 'dev-A',
    ...over,
  };
}

let counter = 0;
const ctx: SessionContext = {
  userId: 'local',
  deviceId: 'dev-A',
  newId: () => `s-new-${(counter += 1)}`,
};

describe('resolveSession', () => {
  it('没有上一个会话 → 新开一个', () => {
    const d = resolveSession(5_000_000, null, ctx);
    expect(d.isNew).toBe(true);
    expect(d.closed).toBeNull();
    expect(d.session.startedAt).toBe(5_000_000);
    expect(d.session.lastActive).toBe(5_000_000);
    expect(d.session.endedAt).toBeNull();
    expect(d.session.deviceId).toBe('dev-A');
    expect(d.session.userId).toBe('local');
  });

  it('★ 上一个会话还在进行中且没超时 → 续上，不新开', () => {
    const last = makeSession({ lastActive: 5_000_000 });
    const d = resolveSession(5_000_000 + 5 * MINUTE, last, ctx);

    expect(d.isNew).toBe(false);
    expect(d.closed).toBeNull();
    expect(d.session.id).toBe('s-old');
    expect(d.session.startedAt).toBe(last.startedAt); // 开始时间不动
    expect(d.session.lastActive).toBe(5_000_000 + 5 * MINUTE); // 活动时间前移
  });

  it('刚好卡在空闲阈值上 → 仍然续上（边界取 <=）', () => {
    const last = makeSession({ lastActive: 5_000_000 });
    const d = resolveSession(5_000_000 + DEFAULT_IDLE_MS, last, ctx);
    expect(d.isNew).toBe(false);
    expect(d.session.id).toBe('s-old');
  });

  it('★ 超过空闲阈值 → 补上结束时间，并且新开一个', () => {
    const last = makeSession({ lastActive: 5_000_000 });
    const now = 5_000_000 + DEFAULT_IDLE_MS + 1;
    const d = resolveSession(now, last, ctx);

    expect(d.isNew).toBe(true);
    expect(d.session.id).not.toBe('s-old');

    // 旧会话被正确地"补算"结束了
    expect(d.closed).not.toBeNull();
    expect(d.closed?.id).toBe('s-old');
    expect(d.closed?.endedAt).toBe(5_000_000 + DEFAULT_IDLE_MS);
  });

  it('补的结束时间是「最后活动 + 阈值」，不是「现在」', () => {
    const last = makeSession({ lastActive: 5_000_000 });
    // 隔了一整天再打开 App
    const d = resolveSession(5_000_000 + 24 * 60 * MINUTE, last, ctx);
    expect(d.closed?.endedAt).toBe(5_000_000 + DEFAULT_IDLE_MS);
  });

  it('上一个会话已经结束了 → 直接新开，不会重复补结束时间', () => {
    const last = makeSession({ endedAt: 5_000_000 + DEFAULT_IDLE_MS });
    const d = resolveSession(9_000_000, last, ctx);

    expect(d.isNew).toBe(true);
    expect(d.closed).toBeNull();
  });

  it('续上时不会改动已结束的会话', () => {
    const last = makeSession({ endedAt: 5_000_000 });
    const d = resolveSession(5_000_001, last, ctx);
    expect(d.isNew).toBe(true);
    expect(d.closed).toBeNull();
  });

  it('可以注入更短的阈值（便于测试，也便于将来做成设置项）', () => {
    const last = makeSession({ lastActive: 5_000_000 });
    const shortCtx: SessionContext = { ...ctx, idleMs: 1000 };

    expect(resolveSession(5_000_500, last, shortCtx).isNew).toBe(false);
    expect(resolveSession(5_001_001, last, shortCtx).isNew).toBe(true);
  });

  it('不会修改传进来的那条记录（纯函数）', () => {
    const last = makeSession({ lastActive: 5_000_000 });
    const snapshot = { ...last };
    resolveSession(5_000_000 + DEFAULT_IDLE_MS + 1, last, ctx);
    expect(last).toEqual(snapshot);
  });
});

describe('sessionDuration', () => {
  it('已结束的会话算到结束时间', () => {
    const s = makeSession({ startedAt: 1000, endedAt: 60_000, lastActive: 59_000 });
    expect(sessionDuration(s)).toBe(59_000);
  });

  it('进行中的会话算到最后活动时间', () => {
    const s = makeSession({ startedAt: 1000, endedAt: null, lastActive: 31_000 });
    expect(sessionDuration(s)).toBe(30_000);
  });

  it('刚开始的会话时长为 0', () => {
    const s = makeSession({ startedAt: 1000, endedAt: null, lastActive: 1000 });
    expect(sessionDuration(s)).toBe(0);
  });
});
