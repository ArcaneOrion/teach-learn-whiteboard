/**
 * 板列表与事件日志的对账
 *
 * ## 为什么需要这个
 *
 * 板的存在与否，本来**应该完全由事件决定**（有一条 `board.create` 事件 = 有这么一块板）。
 * 但 `BoardRecord` 是另一张表，用来给「板列表」快速排序显示 —— 于是它可能落后。
 *
 * 具体什么时候会落后：**同步之后**。
 * 新设备拉到了别人板上的全部事件，但它自己的 `boards` 表里一条记录都没有 ——
 * 结果那块板在界面上**永远不出现**，数据明明就在库里。
 * （我第一次真机同步就踩到了这个：事件全在，板面空白。）
 *
 * ## 做法
 *
 * 扫一遍事件，看看有哪几个 boardId，缺记录的补上，标题从 `board.create` 事件里取。
 * 这就是「事件是唯一真相，其它都是可以重建的投影」那条原则的具体应用。
 */

import type { BoardEvent } from '../core/types';
import type { BoardRecord, Store } from './types';

/** 从事件里推导出一块板的元信息 */
export function deriveBoard(boardId: string, events: readonly BoardEvent[]): BoardRecord {
  const mine = events.filter((e) => e.boardId === boardId);

  // 标题取**最后一条** board.create —— 将来加「重命名」时也是这个规则
  let title = '未命名';
  let createdAt = Number.POSITIVE_INFINITY;
  let updatedAt = 0;

  for (const e of mine) {
    if (e.kind === 'board.create') title = e.payload.title;
    if (e.createdAt < createdAt) createdAt = e.createdAt;
    if (e.createdAt > updatedAt) updatedAt = e.createdAt;
  }
  if (!Number.isFinite(createdAt)) createdAt = updatedAt;

  return { id: boardId, userId: 'local', title, createdAt, updatedAt, archived: 0 };
}

/**
 * 启动时该打开哪块板。
 *
 * ## 为什么不能简单地取「最近更新的那块」
 *
 * 因为 App 一启动就会建一块新板，而新建的板**立刻**会有一条 `board.create` 事件、
 * `updatedAt` 也是现在 —— 于是它永远是最新的。
 * 结果：同步或导入把数据拉回来之后，用户看到的却是一块空板。
 * （我第一次真机同步就踩到了这个。）
 *
 * ## 规则
 *
 * 1. 优先选**有实质内容**的板（除了 board.create 之外还有别的动作）
 * 2. 都没有的话，选最近更新的那块
 * 3. 一块都没有 → 返回 null，由调用方新建
 *
 * @param boards       按 updatedAt 倒序
 * @param contentCount 某块板有多少条「实质内容」事件
 */
export function pickStartupBoard<T extends { id: string }>(
  boards: readonly T[],
  contentCount: (boardId: string) => number,
): T | null {
  for (const board of boards) {
    if (contentCount(board.id) > 0) return board;
  }
  return boards[0] ?? null;
}

/** 「实质内容」= 不是板自身生命周期的那些事件 */
export function countContentEvents(events: readonly BoardEvent[]): number {
  let n = 0;
  for (const e of events) {
    // board.create 只是"这块板存在"，不算用户在上面做了什么
    if (e.kind !== 'board.create') n += 1;
  }
  return n;
}

/**
 * 补齐缺失的板记录。
 *
 * @returns 补了几块
 */
export async function reconcileBoards(store: Store): Promise<number> {
  const events = await store.allEvents();

  const ids = new Set<string>();
  for (const e of events) ids.add(e.boardId);
  if (ids.size === 0) return 0;

  let created = 0;
  for (const boardId of ids) {
    if ((await store.getBoard(boardId)) !== null) continue;
    await store.putBoard(deriveBoard(boardId, events));
    created += 1;
  }
  return created;
}
