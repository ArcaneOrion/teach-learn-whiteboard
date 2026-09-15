/**
 * 内存实现（单元测试用，也作为 IndexedDB 不可用时的兜底）
 *
 * 行为必须和 IndexedDB 实现一致 —— 否则测试通过了、真机上却出问题。
 * 所以两者的接口测试是同一套（见 store/storeContract.ts）。
 */

import type { BoardEvent } from '../core/types';
import type { SessionRecord } from '../core/session';
import type { AttachmentRecord, BoardRecord, Store } from './types';

export class MemoryStore implements Store {
  private readonly events = new Map<string, BoardEvent>();
  private readonly boards = new Map<string, BoardRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly attachments = new Map<string, { record: AttachmentRecord; blob: Blob }>();
  private readonly meta = new Map<string, unknown>();

  async init(): Promise<void> {
    // 内存实现不需要准备
  }

  async appendEvents(events: readonly BoardEvent[]): Promise<void> {
    for (const e of events) {
      // 幂等：同一个 id 重复写入直接忽略
      if (!this.events.has(e.id)) this.events.set(e.id, e);
    }
  }

  async loadEvents(boardId: string): Promise<BoardEvent[]> {
    return [...this.events.values()]
      .filter((e) => e.boardId === boardId)
      .sort((a, b) => a.seq - b.seq);
  }

  async countUnsynced(): Promise<number> {
    let n = 0;
    for (const e of this.events.values()) if (e.synced === 0) n += 1;
    return n;
  }

  async putBoard(board: BoardRecord): Promise<void> {
    this.boards.set(board.id, { ...board });
  }

  async getBoard(id: string): Promise<BoardRecord | null> {
    return this.boards.get(id) ?? null;
  }

  async listBoards(): Promise<BoardRecord[]> {
    return [...this.boards.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async putSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  async lastSession(): Promise<SessionRecord | null> {
    const all = await this.listSessions();
    return all[0] ?? null;
  }

  // ── 附件 ────────────────────────────────────────────────────

  async putAttachment(record: AttachmentRecord, blob: Blob): Promise<void> {
    this.attachments.set(record.id, { record: { ...record }, blob });
  }

  async getAttachment(id: string): Promise<{ record: AttachmentRecord; blob: Blob } | null> {
    return this.attachments.get(id) ?? null;
  }

  async listAttachments(boardId: string): Promise<AttachmentRecord[]> {
    return [...this.attachments.values()]
      .map((a) => a.record)
      .filter((r) => r.boardId === boardId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteAttachment(id: string): Promise<void> {
    this.attachments.delete(id);
  }

  async attachmentBytes(): Promise<number> {
    let total = 0;
    for (const a of this.attachments.values()) total += a.record.bytes;
    return total;
  }

  async getMeta<T>(key: string): Promise<T | null> {
    return (this.meta.get(key) as T | undefined) ?? null;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
  }

  async allMeta(): Promise<{ key: string; value: unknown }[]> {
    return [...this.meta.entries()].map(([key, value]) => ({ key, value }));
  }

  async clear(): Promise<void> {
    this.events.clear();
    this.boards.clear();
    this.sessions.clear();
    this.attachments.clear();
    this.meta.clear();
  }
}
