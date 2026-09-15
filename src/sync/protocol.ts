/**
 * 同步协议
 *
 * 只有两个动作：**推**（把我这边没同步过的事件交上去）和**拉**（把比我新的拿回来）。
 * 协议刻意做得极简 —— 因为事件不可变，服务端其实只需要「按 id 存下来」和「按时间取出来」，
 * 不需要理解板、块、笔迹的任何语义。
 *
 * ## 一个请求就够
 *
 * 推送和拉取放在**同一个请求**里（而不是两个）：
 *   · 少一次往返
 *   · 而且天然是"我先告诉你我到哪了，你顺便把这些给我" —— 顺序不会乱
 *
 * ## 幂等
 *
 * 同一个请求重发多少次结果都一样：服务端按 id 存（重复的覆盖成同样的内容），
 * 客户端合并时按 id 去重。所以**网络断了随便重试**，不需要复杂的重传状态机。
 */

import type { BoardEvent } from '../core/types';
import type { SyncCursor } from '../core/sync';

export interface SyncRequest {
  /** 谁在同步（服务端用它做日志/限流，不参与合并逻辑） */
  deviceId: string;
  /** 我这边已有的最新位置。null = 从没同步过 */
  cursor: SyncCursor | null;
  /** 我要推上去的事件 */
  events: readonly BoardEvent[];
}

export interface SyncResponse {
  /** 服务端现在的（或处理完这次推送之后的）最新位置 */
  cursor: SyncCursor | null;
  /** **严格晚于**请求里 cursor 的事件 */
  events: readonly BoardEvent[];
}

/** 传输层。换成 HTTP、换成 WebSocket、换成测试用的内存实现，同步逻辑都不用改 */
export interface SyncTransport {
  sync(request: SyncRequest): Promise<SyncResponse>;
}
