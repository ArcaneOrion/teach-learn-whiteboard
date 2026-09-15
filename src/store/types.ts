/**
 * 存储层的接口定义
 *
 * 为什么要有这一层接口：**存储的具体实现会换**。
 *   · 现在（M1）：IndexedDB —— 零依赖，桌面浏览器和安卓 WebView 里都能跑
 *   · 单元测试：内存实现
 *   · 将来（M4，需要全文检索时）：可能换成真 SQLite
 *
 * 只要业务代码只依赖这个接口，换实现就不会牵连一片。
 *
 * ⚠️ 与技术文档的一处偏差：文档里写的是 SQLite，这里先用了 IndexedDB。
 *    原因见 docs/技术开发文档.md §11.0（事件日志是只追加的，本来就不需要 SQL；
 *    而 IndexedDB 零依赖、在开发用的桌面浏览器和安卓 WebView 里是同一套代码）。
 */

import type { BoardEvent } from '../core/types';
import type { SessionRecord } from '../core/session';

export interface BoardRecord {
  id: string;
  userId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: 0 | 1;
}

/**
 * 附件（截图等二进制内容）。
 *
 * ⚠️ 为什么**不把图片塞进事件日志**：一张截图一百多 KB，base64 之后更大，
 * 而事件日志每写一笔都要整体读写 —— 几张图就能让它慢得没法用。
 * 所以事件里只存 `attachmentId`，图片本体单独放。
 */
export interface AttachmentRecord {
  id: string;
  userId: string;
  /** 属于哪次会话 */
  sessionId: string | null;
  /** 属于哪块板 */
  boardId: string | null;
  kind: 'snapshot' | 'imported' | 'other';
  mime: string;
  bytes: number;
  width: number;
  height: number;
  /**
   * AI 生成的一句话描述（技术文档 §9.5）。
   * 有了它，**截图才能被文字搜索到** —— 否则图片在检索里等于不存在。
   * M4 才填，现在留 null。
   */
  caption: string | null;
  createdAt: number;
}

export interface Store {
  /** 打开数据库 / 准备就绪 */
  init(): Promise<void>;

  // ── 事件日志（只追加）──────────────────────────────────────

  /** 追加事件。同一批里重复 id 会被忽略（幂等，便于重试） */
  appendEvents(events: readonly BoardEvent[]): Promise<void>;

  /** 读出某块板的全部事件，按 seq 升序 */
  loadEvents(boardId: string): Promise<BoardEvent[]>;

  /** 有几条事件还没同步（M6 用） */
  countUnsynced(): Promise<number>;

  // ── 板 ────────────────────────────────────────────────────

  putBoard(board: BoardRecord): Promise<void>;
  getBoard(id: string): Promise<BoardRecord | null>;
  /** 按最近更新倒序 */
  listBoards(): Promise<BoardRecord[]>;

  // ── 会话 ──────────────────────────────────────────────────

  putSession(session: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** 按开始时间倒序 */
  listSessions(): Promise<SessionRecord[]>;
  /** 最近一次会话（用来判断该续上还是该新开） */
  lastSession(): Promise<SessionRecord | null>;

  // ── 附件（截图等二进制）────────────────────────────────────

  putAttachment(record: AttachmentRecord, blob: Blob): Promise<void>;
  getAttachment(id: string): Promise<{ record: AttachmentRecord; blob: Blob } | null>;
  /** 按创建时间倒序 */
  listAttachments(boardId: string): Promise<AttachmentRecord[]>;
  deleteAttachment(id: string): Promise<void>;
  /** 附件占了多少字节（存储管理要用） */
  attachmentBytes(): Promise<number>;

  // ── 杂项 ──────────────────────────────────────────────────

  getMeta<T>(key: string): Promise<T | null>;
  setMeta(key: string, value: unknown): Promise<void>;
  /** 全部 meta（导出备份要用）。注意里面**含凭据**，导出时必须先剔掉 */
  allMeta(): Promise<{ key: string; value: unknown }[]>;

  /** 清空全部数据（调试与"重置"用） */
  clear(): Promise<void>;
}

/** 统一生成 id 的规则：时间戳 + 随机后缀，同一设备内不重复 */
export function makeId(prefix: string, now: number = Date.now()): string {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
