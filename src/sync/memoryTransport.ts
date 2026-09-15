/**
 * 内存版同步服务端
 *
 * 两个用途：
 *   ① 单元测试里当服务端用（不碰网络，跑得飞快）
 *   ② 单机也能验证同步逻辑 —— 但它**不解决跨设备问题**，只是个替身
 *
 * ⚠️ 它的行为必须和 server/sync-server.mjs 一模一样，
 *    否则会出现「测试通过、真服务器上出问题」。
 *    所以两边都有同一套协议测试盯着（src/sync/protocol.test.ts）。
 */

import type { SyncRequest, SyncResponse, SyncTransport } from './protocol';
import type { BoardEvent } from '../core/types';
import { eventsAfter, latestCursor, mergeEvents } from '../core/sync';

export class MemorySyncServer {
  private events: BoardEvent[] = [];

  /** 服务端现在有多少事件（测试和状态显示用） */
  get size(): number {
    return this.events.length;
  }

  handle(request: SyncRequest): SyncResponse {
    // 1) 收下推上来的（按 id 去重，所以重复推送无害）
    this.events = mergeEvents(this.events, request.events);

    // 2) 把比他新的给他
    const events = eventsAfter(this.events, request.cursor);

    return { cursor: latestCursor(this.events), events };
  }

  /** 测试用：把服务端清空，模拟"换了台设备/服务器重装" */
  reset(): void {
    this.events = [];
  }
}

export class MemoryTransport implements SyncTransport {
  constructor(private readonly server: MemorySyncServer) {}

  sync(request: SyncRequest): Promise<SyncResponse> {
    return Promise.resolve(this.server.handle(request));
  }
}
