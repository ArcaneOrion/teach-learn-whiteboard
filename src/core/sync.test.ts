/**
 * 同步排序与游标的测试
 *
 * 这块的地基性最强：**所有设备必须把同一批事件排成同一个顺序**，
 * 否则折叠出来的板面就不一样 —— 那是最难查的一类同步 bug。
 */

import { describe, expect, it } from 'vitest';

import type { BoardEvent } from './types';
import {
  compareCursor,
  compareGlobalEvents,
  cursorOf,
  eventsAfter,
  latestCursor,
  mergeEvents,
  selectUnsynced,
} from './sync';

function ev(over: Partial<BoardEvent> & { id: string; createdAt: number; deviceId: string }): BoardEvent {
  return {
    boardId: 'b1',
    sessionId: 's1',
    seq: 1,
    actor: 'user',
    kind: 'ink.clear',
    payload: null,
    synced: 0,
    ...over,
  } as BoardEvent;
}

describe('全局排序', () => {
  it('先按时间', () => {
    const a = ev({ id: 'a', createdAt: 100, deviceId: 'dev-A' });
    const b = ev({ id: 'b', createdAt: 200, deviceId: 'dev-A' });
    expect(compareGlobalEvents(a, b)).toBeLessThan(0);
    expect(compareGlobalEvents(b, a)).toBeGreaterThan(0);
  });

  it('★ 时间相同时按设备号定序 —— 两台设备算出来必须一样', () => {
    const a = ev({ id: 'x', createdAt: 100, deviceId: 'dev-A' });
    const b = ev({ id: 'y', createdAt: 100, deviceId: 'dev-B' });

    // 不管传参顺序如何，结果都相同
    expect(compareGlobalEvents(a, b)).toBeLessThan(0);
    expect(compareGlobalEvents(b, a)).toBeGreaterThan(0);
  });

  it('★ 时间和设备号都相同时用 id 兜底，保证全序', () => {
    const a = ev({ id: 'aaa', createdAt: 100, deviceId: 'dev-A' });
    const b = ev({ id: 'bbb', createdAt: 100, deviceId: 'dev-A' });
    expect(compareGlobalEvents(a, b)).toBeLessThan(0);
    expect(compareGlobalEvents(b, a)).toBeGreaterThan(0);
  });

  it('完全不同的一批事件，排序结果稳定（打乱输入也一样）', () => {
    const list = [
      ev({ id: '1', createdAt: 300, deviceId: 'dev-B' }),
      ev({ id: '2', createdAt: 100, deviceId: 'dev-A' }),
      ev({ id: '3', createdAt: 200, deviceId: 'dev-B' }),
      ev({ id: '4', createdAt: 100, deviceId: 'dev-B' }),
    ];
    const sorted = [...list].sort(compareGlobalEvents).map((e) => e.id);
    const shuffled = [list[2]!, list[0]!, list[3]!, list[1]!].sort(compareGlobalEvents).map((e) => e.id);
    expect(shuffled).toEqual(sorted);
    expect(sorted).toEqual(['2', '4', '3', '1']);
  });

  it('compareCursor 对相同的游标返回 0', () => {
    const c = { createdAt: 1, deviceId: 'd', id: 'i' };
    expect(compareCursor(c, c)).toBe(0);
    expect(compareCursor(c, { ...c })).toBe(0);
  });
});

describe('latestCursor', () => {
  it('空数组返回 null', () => {
    expect(latestCursor([])).toBeNull();
  });

  it('返回最大的那个位置', () => {
    const list = [
      ev({ id: 'a', createdAt: 100, deviceId: 'dev-A' }),
      ev({ id: 'c', createdAt: 300, deviceId: 'dev-A' }),
      ev({ id: 'b', createdAt: 200, deviceId: 'dev-A' }),
    ];
    expect(latestCursor(list)).toEqual(cursorOf(list[1]!));
  });

  it('顺序不影响结果', () => {
    const list = [
      ev({ id: 'a', createdAt: 100, deviceId: 'dev-A' }),
      ev({ id: 'c', createdAt: 300, deviceId: 'dev-A' }),
    ];
    expect(latestCursor(list)).toEqual(latestCursor([...list].reverse()));
  });
});

describe('eventsAfter', () => {
  const list = [
    ev({ id: 'a', createdAt: 100, deviceId: 'dev-A' }),
    ev({ id: 'b', createdAt: 200, deviceId: 'dev-A' }),
    ev({ id: 'c', createdAt: 300, deviceId: 'dev-A' }),
  ];

  it('游标为 null 时返回全部，并排好序', () => {
    expect(eventsAfter(list, null).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('★ 严格大于游标 —— 游标指向的那条不再返回', () => {
    expect(eventsAfter(list, cursorOf(list[1]!)).map((e) => e.id)).toEqual(['c']);
  });

  it('游标在最后时返回空', () => {
    expect(eventsAfter(list, cursorOf(list[2]!))).toEqual([]);
  });

  it('★ 同一毫秒里的多条事件不会被游标一次跳过', () => {
    // 这是只按 (时间, 设备号) 做游标会踩的坑：三条事件位置相同
    const same = [
      ev({ id: 'e1', createdAt: 500, deviceId: 'dev-A' }),
      ev({ id: 'e2', createdAt: 500, deviceId: 'dev-A' }),
      ev({ id: 'e3', createdAt: 500, deviceId: 'dev-A' }),
    ];
    // 拿到第一条之后，另外两条仍然能取到
    expect(eventsAfter(same, cursorOf(same[0]!)).map((e) => e.id)).toEqual(['e2', 'e3']);
    expect(eventsAfter(same, cursorOf(same[1]!)).map((e) => e.id)).toEqual(['e3']);
  });
});

describe('mergeEvents', () => {
  it('按 id 去重', () => {
    const a = ev({ id: 'x', createdAt: 100, deviceId: 'dev-A' });
    const merged = mergeEvents([a], [a, a]);
    expect(merged).toHaveLength(1);
  });

  it('★ 幂等：合并两次结果一样', () => {
    const local = [ev({ id: 'a', createdAt: 100, deviceId: 'dev-A' })];
    const incoming = [ev({ id: 'b', createdAt: 200, deviceId: 'dev-B' })];
    const once = mergeEvents(local, incoming);
    const twice = mergeEvents(once, incoming);
    expect(twice).toEqual(once);
  });

  it('合并后按全局顺序排好', () => {
    const local = [ev({ id: 'b', createdAt: 200, deviceId: 'dev-A' })];
    const incoming = [ev({ id: 'a', createdAt: 100, deviceId: 'dev-B' })];
    expect(mergeEvents(local, incoming).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('★ 本地版本优先 —— 它可能已经被标成 synced=1（这个字段只在本机有意义）', () => {
    const remote = ev({ id: 'x', createdAt: 100, deviceId: 'dev-A', synced: 0 });
    const local = { ...remote, synced: 1 as const };
    expect(mergeEvents([local], [remote])[0]?.synced).toBe(1);
  });
});

describe('selectUnsynced', () => {
  it('只挑 synced=0 的', () => {
    const list = [
      ev({ id: 'a', createdAt: 100, deviceId: 'A', synced: 1 }),
      ev({ id: 'b', createdAt: 200, deviceId: 'A', synced: 0 }),
    ];
    expect(selectUnsynced(list).map((e) => e.id)).toEqual(['b']);
  });

  it('★ 按事件自己的状态挑，而不是按游标 —— 时钟不准也不会漏', () => {
    // 这条事件的时间戳**早于**游标（设备时钟慢了，或者刚导入过旧数据），
    // 但它没同步过，所以必须推上去
    const list = [ev({ id: 'old', createdAt: 100, deviceId: 'A', synced: 0 })];
    expect(selectUnsynced(list).map((e) => e.id)).toEqual(['old']);
  });

  it('挑出来的也排好序', () => {
    const list = [
      ev({ id: 'b', createdAt: 200, deviceId: 'A', synced: 0 }),
      ev({ id: 'a', createdAt: 100, deviceId: 'A', synced: 0 }),
    ];
    expect(selectUnsynced(list).map((e) => e.id)).toEqual(['a', 'b']);
  });
});
