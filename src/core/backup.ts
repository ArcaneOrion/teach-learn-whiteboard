/**
 * 备份文件格式
 *
 * ## 为什么这件事是「必需」而不是「锦上添花」
 *
 * 数据存在 App 专属目录 / IndexedDB 里 —— **卸载即删**（技术文档 §15.3 坑二）。
 * 没有导出，用户卸载重装就等于失去全部学习记录。所以导出是**没有它就不能用**的功能。
 *
 * ## 🔒 一个刻意的决定：备份里**不含 API Key**
 *
 * Key 存在 meta 表里（键名前缀 `credential:`）。如果照单全收地导出，
 * 用户的 Key 就会明文躺在一个他可能传到网盘的文件里 ——
 * 那直接违背产品最核心的承诺「**Key 不出设备**」（产品文档第 12 节）。
 *
 * 所以导出时**主动剔除**所有 `credential:` 开头的项。代价是导入后要重新填一次 Key，
 * 但那只是一次性的麻烦，而泄露是不可逆的。
 *
 * ## 分层纪律
 *
 * 纯逻辑：不碰 DOM、不碰存储。解析必须是**防御性的** ——
 * 一个坏文件不该把数据库搞坏，而且报错要说人话。
 */

import type { BoardEvent } from './types';
import type { SessionRecord } from './session';
import type { AttachmentRecord, BoardRecord } from '../store/types';

export const BACKUP_FORMAT = 'teach-learn-whiteboard-backup';
export const BACKUP_VERSION = 1;

/** meta 里这个前缀是凭据，导出时一律剔除 */
const CREDENTIAL_PREFIX = 'credential:';

export interface BackupAttachment {
  record: AttachmentRecord;
  /** 图片等二进制内容，base64（不带 data: 前缀） */
  base64: string;
}

export interface BackupData {
  boards: BoardRecord[];
  sessions: SessionRecord[];
  events: BoardEvent[];
  attachments: BackupAttachment[];
  meta: { key: string; value: unknown }[];
}

export interface BackupFile {
  format: string;
  version: number;
  exportedAt: number;
  /** 备份时 App 是什么版本，将来排查兼容问题要用 */
  appVersion: string;
  data: BackupData;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface MakeBackupInput {
  boards: readonly BoardRecord[];
  sessions: readonly SessionRecord[];
  events: readonly BoardEvent[];
  attachments: readonly BackupAttachment[];
  meta: readonly { key: string; value: unknown }[];
  now: number;
  appVersion: string;
}

export function makeBackup(input: MakeBackupInput): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: input.now,
    appVersion: input.appVersion,
    data: {
      boards: [...input.boards],
      sessions: [...input.sessions],
      events: [...input.events],
      attachments: [...input.attachments],
      // ★ 剔除凭据：备份文件可能被传到任何地方，Key 不该在里面
      meta: input.meta.filter((m) => !m.key.startsWith(CREDENTIAL_PREFIX)),
    },
  };
}

/**
 * 导出时被剔除的凭据条数（界面上要告诉用户「Key 没被导出」）。
 *
 * ⚠️ 值可能是 `null` —— 删掉一个渠道时，凭据是写成 null 而不是删掉那一行。
 * 所以这里必须把 null 排除，否则用户删了渠道之后还会看到「你填了 1 个渠道的 Key」。
 */
export function countCredentials(
  meta: readonly { key: string; value?: unknown }[],
): number {
  return meta.filter(
    (m) => m.key.startsWith(CREDENTIAL_PREFIX) && m.value !== null && m.value !== undefined,
  ).length;
}

// ── 解析与校验 ────────────────────────────────────────────────

function fail(what: string): never {
  throw new BackupError(what);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function arrayOf<T>(root: Record<string, unknown>, key: string): T[] {
  const value = root[key];
  if (!Array.isArray(value)) fail(`备份文件损坏：缺少 ${key}，或者它不是数组`);
  return value as T[];
}

/** 事件最少要有这些字段才敢往库里写 */
function assertEvents(events: readonly unknown[]): void {
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (!isObject(e)) fail(`备份文件损坏：第 ${i + 1} 条事件不是对象`);
    for (const field of ['id', 'boardId', 'seq', 'kind', 'createdAt']) {
      if (e[field] === undefined) {
        fail(`备份文件损坏：第 ${i + 1} 条事件缺少字段 ${field}`);
      }
    }
  }
}

/**
 * 解析备份文件。
 *
 * ⚠️ 校验必须严格：导入会**写进用户的数据库**，
 * 一个半损坏的文件如果被放进去，坏的是他仅有的学习记录。
 * 所以宁可在这里报错拒绝，也不要"尽力而为地导入一半"。
 *
 * @throws {BackupError} 报错信息是给用户看的，不是给程序员看的
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('这不是一个备份文件（无法解析）。请选择本 App 导出的 .json 文件。');
  }

  if (!isObject(raw)) fail('备份文件内容不是一个对象。');

  if (raw['format'] !== BACKUP_FORMAT) {
    fail('这个文件不是本 App 的备份（格式标记不匹配）。');
  }

  const version = raw['version'];
  if (typeof version !== 'number') fail('备份文件缺少版本号。');
  if (version > BACKUP_VERSION) {
    fail(`这个备份来自更新的版本（v${version}），当前 App 只能读到 v${BACKUP_VERSION}。请先升级 App。`);
  }

  const data = raw['data'];
  if (!isObject(data)) fail('备份文件损坏：缺少 data。');

  const events = arrayOf<unknown>(data, 'events');
  assertEvents(events);

  return {
    format: BACKUP_FORMAT,
    version,
    exportedAt: typeof raw['exportedAt'] === 'number' ? raw['exportedAt'] : 0,
    appVersion: typeof raw['appVersion'] === 'string' ? raw['appVersion'] : '未知',
    data: {
      boards: arrayOf<BoardRecord>(data, 'boards'),
      sessions: arrayOf<SessionRecord>(data, 'sessions'),
      events: events as BoardEvent[],
      attachments: arrayOf<BackupAttachment>(data, 'attachments'),
      meta: arrayOf<{ key: string; value: unknown }>(data, 'meta'),
    },
  };
}

/** 人类可读的导出文件名，例如 `共写白板-备份-2026-09-15.json` */
export function backupFileName(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `共写白板-备份-${y}-${m}-${day}.json`;
}

/** 备份里有什么（导入前给用户看，让他确认没选错文件） */
export function describeBackup(backup: BackupFile): string {
  const { events, boards, sessions, attachments } = backup.data;
  const when = new Date(backup.exportedAt).toLocaleString('zh-CN');
  return [
    `导出时间：${when}`,
    `${boards.length} 块板 · ${sessions.length} 次会话 · ${events.length} 条事件 · ${attachments.length} 张截图`,
  ].join('\n');
}
