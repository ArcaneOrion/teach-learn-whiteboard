/**
 * 同步的排序与游标（技术文档 §13）
 *
 * ## 核心洞见
 *
 * 有了事件日志，同步 = **把日志推上去、拉下来**。
 * 因为事件**不可变**，不存在「两边同时改同一个东西」的冲突 ——
 * 唯一要处理的是**顺序**：所有设备必须能把同一批事件排成同一个顺序，
 * 否则折叠出来的板面就不一样。
 *
 * ## 排序规则
 *
 * **不能用 `seq`** —— 它是「板内序号」，两台设备离线时各自递增，一定会撞号。
 * 跨设备只认 `(createdAt, deviceId)`，撞号时用设备号字典序。
 *
 * ## ⚠️ 游标为什么还要带 id
 *
 * 只用 `(createdAt, deviceId)` 做游标有个漏洞：同一台设备在**同一毫秒**里
 * 写了三条事件时，这三个位置是**相同的** —— 对端拉着这个游标来问"给我更新的"，
 * 就会一次跳过三条，而它可能只有其中一条。
 *
 * 加上事件 id（全局唯一）之后，游标就是一个**全序位置**，没有歧义。
 */

import type { BoardEvent } from './types';

/** 一个事件的全局位置。id 是全局唯一的，所以这是一个全序 */
export interface SyncCursor {
  createdAt: number;
  deviceId: string;
  id: string;
}

export function cursorOf(event: BoardEvent): SyncCursor {
  return { createdAt: event.createdAt, deviceId: event.deviceId, id: event.id };
}

/** 游标的排序：先时间，再设备号，最后 id */
export function compareCursor(a: SyncCursor, b: SyncCursor): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 事件的全局排序。**所有设备算出来的结果必须一致** —— 这是同步的地基 */
export function compareGlobalEvents(a: BoardEvent, b: BoardEvent): number {
  return compareCursor(cursorOf(a), cursorOf(b));
}

/** 一批事件里最新的那个位置。空数组返回 null */
export function latestCursor(events: readonly BoardEvent[]): SyncCursor | null {
  let best: SyncCursor | null = null;
  for (const e of events) {
    const c = cursorOf(e);
    if (best === null || compareCursor(c, best) > 0) best = c;
  }
  return best;
}

/**
 * 取出**严格晚于**游标的事件，按全局顺序排好。
 *
 * 用严格大于（而不是大于等于）：游标指向的那条事件是"我已经有了的最新一条"，
 * 不该再拿回来。（同步协议本身是幂等的，拿回来也无害，但没必要多传。）
 */
export function eventsAfter(
  events: readonly BoardEvent[],
  cursor: SyncCursor | null,
): BoardEvent[] {
  const filtered =
    cursor === null ? [...events] : events.filter((e) => compareCursor(cursorOf(e), cursor) > 0);
  return filtered.sort(compareGlobalEvents);
}

/**
 * 把两批事件合起来：按 id 去重，再按全局顺序排好。
 *
 * 幂等 —— 同一批事件合并两次结果一样。这正是同步能安全重试的原因。
 */
export function mergeEvents(
  local: readonly BoardEvent[],
  incoming: readonly BoardEvent[],
): BoardEvent[] {
  const byId = new Map<string, BoardEvent>();
  for (const e of local) byId.set(e.id, e);
  for (const e of incoming) {
    // 本地的优先：它可能已经被标记成 synced=1（这个字段只在本机有意义）
    if (!byId.has(e.id)) byId.set(e.id, e);
  }
  return [...byId.values()].sort(compareGlobalEvents);
}

/**
 * 挑出需要推给远端的事件。
 *
 * 为什么按 `synced === 0` 挑，而不是按游标挑：
 * 游标只说明「拉到哪了」。本机新产生的事件可能**时间戳早于**游标
 * （设备时钟不准，或者刚导入过一批旧数据）—— 按游标挑会把它们永远漏掉。
 * `synced` 是每条事件自己的状态，不受时钟影响。
 */
export function selectUnsynced(events: readonly BoardEvent[]): BoardEvent[] {
  return events.filter((e) => e.synced === 0).sort(compareGlobalEvents);
}
