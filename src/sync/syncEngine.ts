/**
 * 一次同步
 *
 * 顺序很重要：
 *   ① 先推（把本机没同步过的交给服务端）
 *   ② 收到响应后，**先标记已同步**，再合并拉回来的事件
 *   ③ 最后把游标记下来
 *
 * 为什么②要「先标记再合并」：如果标记失败（比如存储写不进去），我们宁可
 * 下次重复推一遍（幂等，无害），也不能出现「以为推上去了、其实没有」——
 * 那种情况下数据**只在本地**，用户换设备就丢了。
 */

import type { Store } from '../store/types';
import type { SyncTransport } from './protocol';
import type { SyncCursor } from '../core/sync';

import { latestCursor, selectUnsynced } from '../core/sync';
import { reconcileBoards } from '../store/boards';

/** 游标存在 meta 里的键名 */
export const SYNC_CURSOR_KEY = 'syncCursor';

export interface SyncResult {
  /** 这次推上去几条 */
  pushed: number;
  /** 服务端给了几条 */
  pulled: number;
  /** 其中**本机原先没有**的有几条（剩下的都是自己推上去又被回传的） */
  merged: number;
  /** 顺便补出来几块「本机还不认识的板」（拉到了别人板上的事件） */
  boardsAdded: number;
  /** 同步之后本机的最新位置 */
  cursor: SyncCursor | null;
  at: number;
}

export interface SyncOptions {
  store: Store;
  transport: SyncTransport;
  deviceId: string;
  now?: () => number;
}

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const { store, transport, deviceId } = options;
  const now = options.now ?? (() => Date.now());

  const local = await store.allEvents();
  const unsynced = selectUnsynced(local);
  const cursor = await store.getMeta<SyncCursor>(SYNC_CURSOR_KEY);

  const response = await transport.sync({ deviceId, cursor, events: unsynced });

  // ★ 先标记：见文件头部的说明
  await store.markSynced(unsynced.map((e) => e.id));

  const known = new Set(local.map((e) => e.id));
  await store.appendEvents(response.events);
  const merged = response.events.filter((e) => !known.has(e.id)).length;

  // ★ 拉回来的事件可能属于本机还不知道的板 —— 得把板记录补出来，
  //   否则那块板在界面上永远不出现（数据明明在库里）。
  const boardsAdded = await reconcileBoards(store);

  // 游标取「本机现在拥有的一切」里最新的那个位置。
  // 不直接用服务端给的 cursor：万一它算错了或者落后了，本机的游标也不会倒退。
  const next = latestCursor(await store.allEvents());
  if (next !== null) await store.setMeta(SYNC_CURSOR_KEY, next);

  return {
    pushed: unsynced.length,
    pulled: response.events.length,
    merged,
    boardsAdded,
    cursor: next,
    at: now(),
  };
}

/** 读一下上次同步到哪了（界面上显示用） */
export async function readCursor(store: Store): Promise<SyncCursor | null> {
  return store.getMeta<SyncCursor>(SYNC_CURSOR_KEY);
}

/** 把游标说成人话 */
export function describeCursor(cursor: SyncCursor | null): string {
  if (cursor === null) return '还没同步过';
  const d = new Date(cursor.createdAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `上次同步到 ${hh}:${mm}`;
}
