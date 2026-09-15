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

/**
 * 读出来的一律给**副本**。
 *
 * ## 为什么这不是"多此一举"
 *
 * IndexedDB 存进去和读出来都经过**结构化克隆** —— 拿到的是副本，
 * 改了它不会影响数据库。内存实现如果直接返回内部对象的引用，
 * 就比真实现**更宽松**：`const b = await store.getBoard(id); b.title = 'x';`
 * 在内存版里"生效"了（因为改的就是同一个对象），在真机上却什么也没发生。
 *
 * 这类分叉最坏的地方是**测试会骗你**：内存实现跑绿，真机不生效。
 * 前几轮踩过的 `appendEvents` 覆盖 `synced` 就是同一类问题
 * （那次是反过来的：内存实现不覆盖、真实现覆盖）。
 *
 * 所以内存实现的原则是：**宁可更严格，不要更宽松** ——
 * 它只是测试和降级用的，不是性能路径，忠实比快重要。
 */
function copy<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  // 兜底（老环境没有 structuredClone）。Blob 之类会退化，但至少不会共享引用
  return JSON.parse(JSON.stringify(value)) as T;
}

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
      // 幂等：同一个 id 重复写入直接忽略。
      // ⚠️ 这里"忽略"不只是省事 —— `synced` 是**本机状态**，
      //    服务端回传的事件里它永远是 0，覆盖回去就会把刚打的同步标记冲掉。
      if (!this.events.has(e.id)) this.events.set(e.id, copy(e));
    }
  }

  async loadEvents(boardId: string): Promise<BoardEvent[]> {
    return [...this.events.values()]
      .filter((e) => e.boardId === boardId)
      .sort((a, b) => a.seq - b.seq)
      .map(copy);
  }

  async allEvents(): Promise<BoardEvent[]> {
    return [...this.events.values()].sort(compareGlobalEvents).map(copy);
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
    this.boards.set(board.id, copy(board));
  }

  async getBoard(id: string): Promise<BoardRecord | null> {
    const row = this.boards.get(id);
    return row === undefined ? null : copy(row);
  }

  async listBoards(): Promise<BoardRecord[]> {
    return [...this.boards.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(copy);
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
    this.sessions.set(session.id, copy(session));
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = this.sessions.get(id);
    return row === undefined ? null : copy(row);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt).map(copy);
  }

  async lastSession(): Promise<SessionRecord | null> {
    const all = await this.listSessions();
    return all[0] ?? null;
  }

  // ── 附件 ────────────────────────────────────────────────────

  async putAttachment(record: AttachmentRecord, blob: Blob): Promise<void> {
    this.attachments.set(record.id, { record: copy(record), blob });
  }

  async getAttachment(id: string): Promise<{ record: AttachmentRecord; blob: Blob } | null> {
    const row = this.attachments.get(id);
    return row === undefined ? null : { record: copy(row.record), blob: row.blob };
  }

  async listAttachments(boardId: string): Promise<AttachmentRecord[]> {
    return [...this.attachments.values()]
      .map((a) => a.record)
      .filter((r) => r.boardId === boardId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(copy);
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
    this.docs.set(record.id, copy(record));
  }

  async getDoc(id: string): Promise<DocRecord | null> {
    const row = this.docs.get(id);
    return row === undefined ? null : copy(row);
  }

  async listDocs(): Promise<DocRecord[]> {
    return [...this.docs.values()].sort((a, b) => b.importedAt - a.importedAt).map(copy);
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
    for (const chunk of chunks) this.chunks.set(chunk.id, copy(chunk));
  }

  async allChunks(): Promise<ChunkRecord[]> {
    return [...this.chunks.values()]
      .sort((a, b) => (a.docId === b.docId ? a.ord - b.ord : a.docId < b.docId ? -1 : 1))
      .map(copy);
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
    const value = this.meta.get(key);
    return value === undefined ? null : copy(value as T);
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, copy(value));
  }

  async allMeta(): Promise<{ key: string; value: unknown }[]> {
    // 按 key 排好 —— 和 IndexedDB 实现保持一致（那边 get 出来是主键顺序）
    return [...this.meta.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, value]) => ({ key, value: copy(value) }));
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
