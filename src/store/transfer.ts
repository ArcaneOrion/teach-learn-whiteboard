/**
 * 备份的导出与导入（存储层）
 *
 * 格式与校验在 core/backup.ts（纯逻辑、可测）；这里只负责和存储打交道。
 *
 * ## 导入用「合并」而不是「覆盖」
 *
 * 因为**事件是不可变的、id 是唯一的**，合并天然安全：
 * 同一批事件导两次结果一样（appendEvents 是幂等的），不同来源的事件也不会打架。
 *
 * 这不只是省事 —— 它**正是 M6 同步要用的那套机制**。现在把导入做成合并，
 * 等于提前验证了一遍同步的核心假设。
 */

import type { BoardEvent } from '../core/types';
import type { AttachmentRecord, Store } from './types';
import type { BackupAttachment, BackupFile } from '../core/backup';

import { base64ToBlob, blobToBase64 } from '../base64';
import { makeBackup } from '../core/backup';

export interface ImportSummary {
  boards: number;
  sessions: number;
  events: number;
  attachments: number;
  meta: number;
}

/** 把所有数据打包成一个备份对象 */
export async function exportBackup(store: Store, appVersion: string, now: number): Promise<BackupFile> {
  const boards = await store.listBoards();
  const sessions = await store.listSessions();

  // 事件是按板取的（Store 接口就是这么设计的）。板的数量不多，逐个取没问题
  const events: BoardEvent[] = [];
  for (const board of boards) {
    events.push(...(await store.loadEvents(board.id)));
  }

  const attachments: BackupAttachment[] = [];
  for (const board of boards) {
    for (const record of await store.listAttachments(board.id)) {
      const found = await store.getAttachment(record.id);
      if (found === null) continue; // 记录在、文件丢了 —— 跳过，不让整个导出失败
      attachments.push({ record, base64: await blobToBase64(found.blob) });
    }
  }

  return makeBackup({
    boards,
    sessions,
    events,
    attachments,
    meta: await store.allMeta(),
    now,
    appVersion,
  });
}

/**
 * 把备份合并进存储。
 *
 * 幂等：同一个文件导两次，第二次什么都不会变。
 */
export async function importBackup(store: Store, backup: BackupFile): Promise<ImportSummary> {
  const { boards, sessions, events, attachments, meta } = backup.data;

  for (const board of boards) await store.putBoard(board);
  for (const session of sessions) await store.putSession(session);
  await store.appendEvents(events);

  for (const item of attachments) {
    const record: AttachmentRecord = item.record;
    await store.putAttachment(record, base64ToBlob(item.base64, record.mime));
  }

  // ★ 凭据**一律不导入**，无条件跳过。
  //
  // 为什么不是「本机没有就补进来」：
  //   我们自己的导出**根本不含凭据**（见 core/backup.ts），
  //   所以凭据只可能来自**手工伪造的备份文件**。
  //   而接受它意味着：别人给你一个备份，你的所有请求就都走他的 Key、
  //   经过他的服务器 —— 你写的东西他全看得见。
  //
  // 「换设备恢复」这个场景不需要它：本来备份里就没有 Key，重新填一次即可。
  let metaCount = 0;
  for (const item of meta) {
    if (item.key.startsWith('credential:')) continue;
    await store.setMeta(item.key, item.value);
    metaCount += 1;
  }

  return {
    boards: boards.length,
    sessions: sessions.length,
    events: events.length,
    attachments: attachments.length,
    meta: metaCount,
  };
}

/** 把备份对象变成可下载的文件 */
export function backupToBlob(backup: BackupFile): Blob {
  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让某些浏览器来不及下载，延后一点
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 读一个用户选的文件为文本 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file);
  });
}
