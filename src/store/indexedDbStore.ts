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
import type { AttachmentRecord, BoardRecord, ChunkRecord, DocRecord, Store } from './types';
import { compareGlobalEvents } from '../core/sync';

const DB_NAME = 'teach-learn-whiteboard';
/**
 * ⚠️ 加对象仓库（object store）必须同时**加版本号**，否则升级回调不会跑，
 * 新仓库根本不会被创建 —— 而且**不报错**，直到你第一次用到它才炸。
 *
 * ⚠️⚠️ **加版本号和加建表语句必须是同一次改动**。
 * 我踩过一次：先升版本号、再加语句，两步之间 dev server 热重载了 ——
 * 数据库升到了 v2 但仓库没建，版本号已经往前走，那个库就永远缺一个仓库。
 * 所以建表写在幂等的 ensureSchema 里（缺哪个补哪个），坏状态能自愈。
 *
 * v1：events / boards / sessions / meta
 * v2：+ attachments（截图）
 * v3：修上面那次事故
 * v4：+ docs / chunks（资料，M7）
 */
const DB_VERSION = 4;

const STORE_EVENTS = 'events';
const STORE_BOARDS = 'boards';
const STORE_SESSIONS = 'sessions';
const STORE_META = 'meta';
const STORE_ATTACHMENTS = 'attachments';
const STORE_DOCS = 'docs';
const STORE_CHUNKS = 'chunks';

/** 这个数据库里**应该**有哪些仓库。init() 用它检查并自愈 */
const REQUIRED_STORES = [
  STORE_EVENTS,
  STORE_BOARDS,
  STORE_SESSIONS,
  STORE_META,
  STORE_ATTACHMENTS,
  STORE_DOCS,
  STORE_CHUNKS,
];

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
  if (!db.objectStoreNames.contains(STORE_DOCS)) {
    const docs = db.createObjectStore(STORE_DOCS, { keyPath: 'id' });
    docs.createIndex('by_importedAt', 'importedAt');
  }
  if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
    const chunks = db.createObjectStore(STORE_CHUNKS, { keyPath: 'id' });
    // 按「文档 + 块序号」取值，也方便按文档整批删
    chunks.createIndex('by_doc_ord', ['docId', 'ord']);
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

    this.db = await this.openAtLeast(DB_VERSION);

    /**
     * ★ 自愈：万一有仓库缺失，把版本号往前走一格重开。
     *
     * 为什么需要它 —— 我**两次**踩到同一个坑：
     * 加仓库时要改两个地方（版本号 + 建表语句），我一不小心分两次改，
     * 中间 dev server 热重载了。于是数据库升到了新版本、但仓库没建。
     * 版本号已经走过，升级回调**再也不会跑**，那个库就永远缺一个仓库，
     * 直到第一次用到它才炸（`One of the specified object stores was not found`）。
     *
     * 光靠"记得一次改完"是不可靠的 —— 让代码自己发现并修复才行。
     */
    const missing = REQUIRED_STORES.filter((name) => !this.db!.objectStoreNames.contains(name));
    if (missing.length > 0) {
      console.warn(`数据库缺了这些仓库：${missing.join('、')} —— 自动升级修复`);

      const nextVersion = this.db.version + 1;
      this.db.close();
      this.db = null;

      /**
       * ⚠️ 关掉之后**必须让出一拍再重开**。
       *
       * `IDBDatabase.close()` 是**异步**的：它只是标记"要关了"，
       * 真正断开要等当前事务跑完。紧接着就 `open(更高版本)` 的话，
       * 旧连接还被算作"开着"，升级请求会一直 `blocked`。
       */
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        try {
          this.db = await this.openAtLeast(nextVersion);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (this.db === null) {
        throw lastError instanceof Error ? lastError : new Error('升级数据库失败');
      }
    }
  }

  /**
   * 按**不低于** minVersion 的版本打开。
   *
   * ⚠️ 为什么不能直接 `open(DB_VERSION)` —— 这个坑很难看：
   *
   * 自愈会把数据库升到比代码里的 `DB_VERSION` 更高的版本。
   * 而 `indexedDB.open(name, 更低的版本)` 会抛 **`VersionError`**（这是规范行为）。
   * 于是 App **再也打不开自己的数据库**，每次都退回内存存储 ——
   * 表现是"刷新之后数据全没了"，而且只有真浏览器会这样
   * （fake-indexeddb 的时序/校验和真实实现不一样，单元测试没抓到）。
   *
   * 所以：版本比代码高的时候，按"当前版本"打开就行（不传版本号）。
   */
  private async openAtLeast(minVersion: number): Promise<IDBDatabase> {
    try {
      return await this.open(minVersion);
    } catch (err) {
      const isVersionError =
        err instanceof DOMException
          ? err.name === 'VersionError'
          : err instanceof Error && err.name === 'VersionError';
      if (!isVersionError) throw err;
      return this.open();
    }
  }

  private open(version?: number): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const open =
        version === undefined
          ? indexedDB.open(DB_NAME)
          : indexedDB.open(DB_NAME, version);

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

  /**
   * 关掉连接。
   *
   * 应用本身不需要调它（一个会话开一次就够了），但**测试需要**：
   * 上一个用例留下的连接会把数据库升级/删除请求挡住，
   * 表现是"下一个用例莫名其妙超时"，而不是一个清楚的报错。
   */
  close(): void {
    this.db?.close();
    this.db = null;
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

  async allEvents(): Promise<BoardEvent[]> {
    const tx = this.need().transaction(STORE_EVENTS, 'readonly');
    const rows = await req(tx.objectStore(STORE_EVENTS).getAll() as IDBRequest<BoardEvent[]>);
    await txDone(tx);
    return rows.sort(compareGlobalEvents);
  }

  async markSynced(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = this.need().transaction(STORE_EVENTS, 'readwrite');
    const os = tx.objectStore(STORE_EVENTS);
    // 一个事务里做完读改写，避免中间被别的写插进来
    for (const id of ids) {
      const event = await req(os.get(id) as IDBRequest<BoardEvent | undefined>);
      if (event !== undefined) os.put({ ...event, synced: 1 });
    }
    await txDone(tx);
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

  async deleteBoard(id: string): Promise<void> {
    // 先把要删的事件 id 和附件 id 查出来（独立事务），
    // 再在一个事务里把所有东西一起删 —— 免得删到一半留下孤儿
    const eventIds = await this.idsOfBoard(STORE_EVENTS, 'by_board_seq', id);
    const attachmentIds = await this.idsOfBoard(STORE_ATTACHMENTS, 'by_board_createdAt', id);

    const tx = this.need().transaction(
      [STORE_BOARDS, STORE_EVENTS, STORE_ATTACHMENTS],
      'readwrite',
    );
    tx.objectStore(STORE_BOARDS).delete(id);
    const events = tx.objectStore(STORE_EVENTS);
    for (const eventId of eventIds) events.delete(eventId);
    const attachments = tx.objectStore(STORE_ATTACHMENTS);
    for (const attachmentId of attachmentIds) attachments.delete(attachmentId);
    await txDone(tx);
  }

  /** 按 [boardId, 序号] 索引查出某块板下所有记录的 id */
  private async idsOfBoard(storeName: string, indexName: string, boardId: string): Promise<string[]> {
    const tx = this.need().transaction(storeName, 'readonly');
    const index = tx.objectStore(storeName).index(indexName);
    const range = IDBKeyRange.bound([boardId, 0], [boardId, Number.MAX_SAFE_INTEGER]);
    const keys = await req(index.getAllKeys(range) as IDBRequest<IDBValidKey[]>);
    await txDone(tx);
    return keys.filter((k): k is string => typeof k === 'string');
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

  // ── 资料 ────────────────────────────────────────────────────

  async putDoc(record: DocRecord): Promise<void> {
    const tx = this.need().transaction(STORE_DOCS, 'readwrite');
    tx.objectStore(STORE_DOCS).put(record);
    await txDone(tx);
  }

  async getDoc(id: string): Promise<DocRecord | null> {
    const tx = this.need().transaction(STORE_DOCS, 'readonly');
    const row = await req(tx.objectStore(STORE_DOCS).get(id) as IDBRequest<DocRecord | undefined>);
    await txDone(tx);
    return row ?? null;
  }

  async listDocs(): Promise<DocRecord[]> {
    const tx = this.need().transaction(STORE_DOCS, 'readonly');
    const rows = await req(tx.objectStore(STORE_DOCS).getAll() as IDBRequest<DocRecord[]>);
    await txDone(tx);
    return rows.sort((a, b) => b.importedAt - a.importedAt);
  }

  /** 查出某份文档现有的块 id */
  private async chunkIdsOf(docId: string): Promise<string[]> {
    const tx = this.need().transaction(STORE_CHUNKS, 'readonly');
    const index = tx.objectStore(STORE_CHUNKS).index('by_doc_ord');
    const range = IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]);
    const keys = await req(index.getAllKeys(range) as IDBRequest<IDBValidKey[]>);
    await txDone(tx);
    return keys.filter((k): k is string => typeof k === 'string');
  }

  async deleteDoc(id: string): Promise<void> {
    const chunkIds = await this.chunkIdsOf(id);

    // 文档和它的块放在**同一个事务**里删 —— 分开删的话，
    // 中途失败会留下永远检索不到、也永远删不掉的孤儿块
    const tx = this.need().transaction([STORE_DOCS, STORE_CHUNKS], 'readwrite');
    tx.objectStore(STORE_DOCS).delete(id);
    const os = tx.objectStore(STORE_CHUNKS);
    for (const chunkId of chunkIds) os.delete(chunkId);
    await txDone(tx);
  }

  async putChunks(docId: string, chunks: readonly ChunkRecord[]): Promise<void> {
    /**
     * ⚠️ 必须**先查出旧块的 id、再在一个事务里删旧写新**。
     *
     * 踩过的坑：一开始是用游标边遍历边删，然后在同一段代码里直接写新块 ——
     * 但游标的回调是异步的，新块**先**写进去了，游标随后遍历到它、把它也删了。
     * 症状是"重新导入之后资料搜不到了"，而且只有 IndexedDB 实现有问题
     * （内存实现是同步的，看不出这个 bug）——
     * 这正是「两个实现跑同一套契约测试」抓出来的。
     */
    const oldIds = await this.chunkIdsOf(docId);

    const tx = this.need().transaction(STORE_CHUNKS, 'readwrite');
    const os = tx.objectStore(STORE_CHUNKS);
    for (const id of oldIds) os.delete(id);
    for (const chunk of chunks) os.put(chunk);
    await txDone(tx);
  }

  async allChunks(): Promise<ChunkRecord[]> {
    const tx = this.need().transaction(STORE_CHUNKS, 'readonly');
    const rows = await req(tx.objectStore(STORE_CHUNKS).getAll() as IDBRequest<ChunkRecord[]>);
    await txDone(tx);
    return rows;
  }

  async countChunks(): Promise<number> {
    const tx = this.need().transaction(STORE_CHUNKS, 'readonly');
    const n = await req(tx.objectStore(STORE_CHUNKS).count());
    await txDone(tx);
    return n;
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

  async allMeta(): Promise<{ key: string; value: unknown }[]> {
    const tx = this.need().transaction(STORE_META, 'readonly');
    const rows = await req(
      tx.objectStore(STORE_META).getAll() as IDBRequest<{ key: string; value: unknown }[]>,
    );
    await txDone(tx);
    return rows;
  }

  async clear(): Promise<void> {
    const names = [
      STORE_EVENTS,
      STORE_BOARDS,
      STORE_SESSIONS,
      STORE_META,
      STORE_ATTACHMENTS,
      STORE_DOCS,
      STORE_CHUNKS,
    ];
    const tx = this.need().transaction(names, 'readwrite');
    for (const name of names) tx.objectStore(name).clear();
    await txDone(tx);
  }
}
