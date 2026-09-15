/**
 * IndexedDB 实现 —— 真正落盘的那一份
 *
 * 为什么用 IndexedDB 而不是 SQLite（与技术文档的一处偏差，理由见 §11.0）：
 *   · 事件日志是**只追加**的，只需要"追加"和"按板顺序读出"两个操作，本来就不需要 SQL
 *   · IndexedDB **零依赖**，而且是浏览器和安卓 WebView 里**同一套代码** ——
 *     开发时在电脑浏览器里跑的就是将来手机上跑的那套，不用维护两份实现
 *   · Capacitor 的 SQLite 插件在网页端要额外引 WASM + 一个 web component，
 *     对新手是很多会出错的零件
 *
 * 将来 M4 做全文检索时如果确实需要 SQL，再在 Store 接口后面加一个实现即可 ——
 * 业务代码不受影响。
 */

import type { BoardEvent } from '../core/types';
import type { SessionRecord } from '../core/session';
import type { AttachmentRecord, BoardRecord, Store } from './types';

const DB_NAME = 'teach-learn-whiteboard';
/**
 * ⚠️ 加对象仓库（object store）必须同时**加版本号**，否则升级回调不会跑，
 * 新仓库根本不会被创建 —— 而且**不报错**，直到你第一次用到它才炸。
 *
 * v1：events / boards / sessions / meta
 * v2：+ attachments（截图）
 * v3：修一个自己造成的事故 —— 见下方 ensureSchema 的注释
 */
const DB_VERSION = 3;

const STORE_EVENTS = 'events';
const STORE_BOARDS = 'boards';
const STORE_SESSIONS = 'sessions';
const STORE_META = 'meta';
const STORE_ATTACHMENTS = 'attachments';

/** 附件在库里的实际形态：元数据 + 二进制放在同一条记录里 */
interface StoredAttachment extends AttachmentRecord {
  blob: Blob;
}

/**
 * 建表。**写成幂等**：每缺少哪个仓库就补哪个。
 *
 * ⚠️ 为什么要这样写 —— 我踩过一次：
 *   加附件仓库时，我分两步改代码：先升版本号、再加建仓库的语句。
 *   两步之间 dev server 热重载了，于是数据库**升到了 v2 但仓库没建**。
 *   版本号已经是 2 了，以后再也不会触发升级 —— 那个库就永远缺一个仓库，
 *   直到第一次用到它才炸（`One of the specified object stores was not found`）。
 *
 * 幂等的写法 + 版本号往前走一格，这种坏状态就能自愈。
 */
function ensureSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_EVENTS)) {
    const events = db.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
    // 按「板 + 板内序号」取值，正好是折叠需要的顺序
    events.createIndex('by_board_seq', ['boardId', 'seq']);
    events.createIndex('by_synced', 'synced');
  }
  if (!db.objectStoreNames.contains(STORE_BOARDS)) {
    const boards = db.createObjectStore(STORE_BOARDS, { keyPath: 'id' });
    boards.createIndex('by_updatedAt', 'updatedAt');
  }
  if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
    const sessions = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
    sessions.createIndex('by_startedAt', 'startedAt');
  }
  if (!db.objectStoreNames.contains(STORE_META)) {
    db.createObjectStore(STORE_META, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) {
    const attachments = db.createObjectStore(STORE_ATTACHMENTS, { keyPath: 'id' });
    attachments.createIndex('by_board_createdAt', ['boardId', 'createdAt']);
  }
}

/** 把 IDBRequest 包成 Promise */
function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 等一个事务真正提交完成 —— 不 await 它的话，"写成功"只是内存里的假象 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中止'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务出错'));
  });
}

export class IndexedDbStore implements Store {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db !== null) return;

    if (typeof indexedDB === 'undefined') {
      throw new Error('这个环境没有 IndexedDB');
    }

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);

      open.onupgradeneeded = () => {
        ensureSchema(open.result);
      };

      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('打开 IndexedDB 失败'));
      // 另一个标签页在升级数据库时会挡住，这里直接报错而不是永久卡住
      open.onblocked = () => reject(new Error('数据库被另一个标签页占用，请关掉其它标签页再试'));
    });
  }

  private need(): IDBDatabase {
    if (this.db === null) throw new Error('Store 还没 init()');
    return this.db;
  }

  // ── 事件 ────────────────────────────────────────────────────

  async appendEvents(events: readonly BoardEvent[]): Promise<void> {
    if (events.length === 0) return;
    const tx = this.need().transaction(STORE_EVENTS, 'readwrite');
    const os = tx.objectStore(STORE_EVENTS);
    for (const e of events) {
      // put 而不是 add：同一批事件重试时不会因为 id 已存在而整批失败（幂等）
      os.put(e);
    }
    await txDone(tx);
  }

  async loadEvents(boardId: string): Promise<BoardEvent[]> {
    const tx = this.need().transaction(STORE_EVENTS, 'readonly');
    const index = tx.objectStore(STORE_EVENTS).index('by_board_seq');
    // 数组主键的比较是逐项字典序，所以 [boardId, 0] .. [boardId, MAX] 正好圈出这块板的全部事件
    const range = IDBKeyRange.bound(
      [boardId, 0],
      [boardId, Number.MAX_SAFE_INTEGER],
    );
    const rows = await req(index.getAll(range) as IDBRequest<BoardEvent[]>);
    await txDone(tx);
    return rows.sort((a, b) => a.seq - b.seq);
  }

  async countUnsynced(): Promise<number> {
    const tx = this.need().transaction(STORE_EVENTS, 'readonly');
    const index = tx.objectStore(STORE_EVENTS).index('by_synced');
    const n = await req(index.count(IDBKeyRange.only(0)));
    await txDone(tx);
    return n;
  }

  // ── 板 ──────────────────────────────────────────────────────

  async putBoard(board: BoardRecord): Promise<void> {
    const tx = this.need().transaction(STORE_BOARDS, 'readwrite');
    tx.objectStore(STORE_BOARDS).put(board);
    await txDone(tx);
  }

  async getBoard(id: string): Promise<BoardRecord | null> {
    const tx = this.need().transaction(STORE_BOARDS, 'readonly');
    const row = await req(tx.objectStore(STORE_BOARDS).get(id) as IDBRequest<BoardRecord | undefined>);
    await txDone(tx);
    return row ?? null;
  }

  async listBoards(): Promise<BoardRecord[]> {
    const tx = this.need().transaction(STORE_BOARDS, 'readonly');
    const rows = await req(tx.objectStore(STORE_BOARDS).getAll() as IDBRequest<BoardRecord[]>);
    await txDone(tx);
    // 最近更新的排前面
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ── 会话 ────────────────────────────────────────────────────

  async putSession(session: SessionRecord): Promise<void> {
    const tx = this.need().transaction(STORE_SESSIONS, 'readwrite');
    tx.objectStore(STORE_SESSIONS).put(session);
    await txDone(tx);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const tx = this.need().transaction(STORE_SESSIONS, 'readonly');
    const row = await req(tx.objectStore(STORE_SESSIONS).get(id) as IDBRequest<SessionRecord | undefined>);
    await txDone(tx);
    return row ?? null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const tx = this.need().transaction(STORE_SESSIONS, 'readonly');
    const rows = await req(tx.objectStore(STORE_SESSIONS).getAll() as IDBRequest<SessionRecord[]>);
    await txDone(tx);
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  }

  async lastSession(): Promise<SessionRecord | null> {
    const tx = this.need().transaction(STORE_SESSIONS, 'readonly');
    const index = tx.objectStore(STORE_SESSIONS).index('by_startedAt');
    // 游标倒着走一格，就是开始时间最晚的那条 —— 不用把全部会话读出来
    const row = await new Promise<SessionRecord | null>((resolve, reject) => {
      const cursorReq = index.openCursor(null, 'prev');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        resolve(cursor === null ? null : (cursor.value as SessionRecord));
      };
      cursorReq.onerror = () => reject(cursorReq.error ?? new Error('读取最近会话失败'));
    });
    await txDone(tx);
    return row;
  }

  // ── 附件 ────────────────────────────────────────────────────

  async putAttachment(record: AttachmentRecord, blob: Blob): Promise<void> {
    const tx = this.need().transaction(STORE_ATTACHMENTS, 'readwrite');
    // IndexedDB 原生就能存 Blob，不需要转 base64（省一大截空间）
    tx.objectStore(STORE_ATTACHMENTS).put({ ...record, blob } satisfies StoredAttachment);
    await txDone(tx);
  }

  async getAttachment(id: string): Promise<{ record: AttachmentRecord; blob: Blob } | null> {
    const tx = this.need().transaction(STORE_ATTACHMENTS, 'readonly');
    const row = await req(
      tx.objectStore(STORE_ATTACHMENTS).get(id) as IDBRequest<StoredAttachment | undefined>,
    );
    await txDone(tx);
    if (row === undefined) return null;
    const { blob, ...record } = row;
    return { record, blob };
  }

  async listAttachments(boardId: string): Promise<AttachmentRecord[]> {
    const tx = this.need().transaction(STORE_ATTACHMENTS, 'readonly');
    const index = tx.objectStore(STORE_ATTACHMENTS).index('by_board_createdAt');
    const range = IDBKeyRange.bound([boardId, 0], [boardId, Number.MAX_SAFE_INTEGER]);
    const rows = await req(index.getAll(range) as IDBRequest<StoredAttachment[]>);
    await txDone(tx);
    // 新拍的排前面
    return rows
      .map(({ blob: _blob, ...record }) => record)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteAttachment(id: string): Promise<void> {
    const tx = this.need().transaction(STORE_ATTACHMENTS, 'readwrite');
    tx.objectStore(STORE_ATTACHMENTS).delete(id);
    await txDone(tx);
  }

  async attachmentBytes(): Promise<number> {
    const tx = this.need().transaction(STORE_ATTACHMENTS, 'readonly');
    const rows = await req(
      tx.objectStore(STORE_ATTACHMENTS).getAll() as IDBRequest<StoredAttachment[]>,
    );
    await txDone(tx);
    let total = 0;
    for (const r of rows) total += r.bytes;
    return total;
  }

  // ── 杂项 ────────────────────────────────────────────────────

  async getMeta<T>(key: string): Promise<T | null> {
    const tx = this.need().transaction(STORE_META, 'readonly');
    const row = await req(
      tx.objectStore(STORE_META).get(key) as IDBRequest<{ key: string; value: T } | undefined>,
    );
    await txDone(tx);
    return row?.value ?? null;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const tx = this.need().transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    await txDone(tx);
  }

  async clear(): Promise<void> {
    const names = [STORE_EVENTS, STORE_BOARDS, STORE_SESSIONS, STORE_META, STORE_ATTACHMENTS];
    const tx = this.need().transaction(names, 'readwrite');
    for (const name of names) tx.objectStore(name).clear();
    await txDone(tx);
  }
}
