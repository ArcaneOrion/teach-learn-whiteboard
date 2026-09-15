/**
 * 内存实现（单元测试用，也作为 IndexedDB 不可用时的兜底）
 *
 * 行为必须和 IndexedDB 实现一致 —— 否则测试通过了、真机上却出问题。
 * 所以两者的接口测试是同一套（见 store/storeContract.ts）。
 */

import type { BoardEvent } from '../core/types';
import type { SessionRecord } from '../core/session';
import type { AttachmentRecord, BoardRecord, ChunkRecord, DocRecord, Store } from './types';
import { compareGlobalEvents } from '../core/sync';

export class MemoryStore implements Store {
  private readonly events = new Map<string, BoardEvent>();
  private readonly boards = new Map<string, BoardRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly attachments = new Map<string, { record: AttachmentRecord; blob: Blob }>();
  private readonly docs = new Map<string, DocRecord>();
  private readonly chunks = new Map<string, ChunkRecord>();
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

  async allEvents(): Promise<BoardEvent[]> {
    return [...this.events.values()].sort(compareGlobalEvents);
  }

  async markSynced(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const event = this.events.get(id);
      if (event !== undefined) this.events.set(id, { ...event, synced: 1 });
    }
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

  async deleteBoard(id: string): Promise<void> {
    this.boards.delete(id);
    for (const [eventId, event] of this.events) {
      if (event.boardId === id) this.events.delete(eventId);
    }
    for (const [attId, att] of this.attachments) {
      if (att.record.boardId === id) this.attachments.delete(attId);
    }
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

  // ── 资料 ────────────────────────────────────────────────────

  async putDoc(record: DocRecord): Promise<void> {
    this.docs.set(record.id, { ...record });
  }

  async getDoc(id: string): Promise<DocRecord | null> {
    return this.docs.get(id) ?? null;
  }

  async listDocs(): Promise<DocRecord[]> {
    return [...this.docs.values()].sort((a, b) => b.importedAt - a.importedAt);
  }

  async deleteDoc(id: string): Promise<void> {
    this.docs.delete(id);
    // 块要一起删掉 —— 留着就是永远检索不到、也永远删不掉的垃圾
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.docId === id) this.chunks.delete(chunkId);
    }
  }

  async putChunks(docId: string, chunks: readonly ChunkRecord[]): Promise<void> {
    // 先清掉这份文档原有的块（重新导入时不该留下旧版本）
    await this.deleteChunksOf(docId);
    for (const chunk of chunks) this.chunks.set(chunk.id, { ...chunk });
  }

  async allChunks(): Promise<ChunkRecord[]> {
    return [...this.chunks.values()].sort((a, b) =>
      a.docId === b.docId ? a.ord - b.ord : a.docId < b.docId ? -1 : 1,
    );
  }

  async countChunks(): Promise<number> {
    return this.chunks.size;
  }

  private async deleteChunksOf(docId: string): Promise<void> {
    for (const [chunkId, chunk] of this.chunks) {
      if (chunk.docId === docId) this.chunks.delete(chunkId);
    }
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
    this.docs.clear();
    this.chunks.clear();
    this.meta.clear();
  }
}
