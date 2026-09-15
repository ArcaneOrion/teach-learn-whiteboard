/**
 * 备份往返的测试
 *
 * 最要紧的两条：
 *   · 导出再导入，数据要**一模一样**（二进制也要一样）
 *   · 导入要被设计成**幂等**的 —— 这不只是省事，它正是 M6 同步要用的那套机制
 */

import { describe, expect, it } from 'vitest';

import type { BoardEvent } from '../core/types';
import { MemoryStore } from './memoryStore';
import { exportBackup, importBackup } from './transfer';
import { parseBackup } from '../core/backup';

function event(over: Partial<BoardEvent> & { id: string; seq: number }): BoardEvent {
  return {
    boardId: 'b1',
    sessionId: 's1',
    actor: 'user',
    kind: 'ink.clear',
    payload: null,
    createdAt: 1000 + over.seq,
    deviceId: 'dev',
    synced: 0,
    ...over,
  } as BoardEvent;
}

async function seededStore() {
  const store = new MemoryStore();
  await store.init();

  await store.putBoard({
    id: 'b1', userId: 'local', title: '一元二次方程',
    createdAt: 1000, updatedAt: 2000, archived: 0,
  });
  await store.putSession({
    id: 's1', userId: 'local', title: null,
    startedAt: 1000, endedAt: 2000, lastActive: 2000, deviceId: 'dev',
  });
  await store.appendEvents([event({ id: 'e1', seq: 1 }), event({ id: 'e2', seq: 2 })]);
  await store.putAttachment(
    {
      id: 'a1', userId: 'local', sessionId: 's1', boardId: 'b1', kind: 'snapshot',
      mime: 'image/png', bytes: 4, width: 10, height: 10, caption: null, createdAt: 1500,
    },
    new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
  );
  await store.setMeta('deviceId', 'dev-abc');
  await store.setMeta('credential:ch-1', { type: 'api_key', key: 'sk-secret' });

  return store;
}

describe('导出', () => {
  it('把所有数据都打包进去', async () => {
    const store = await seededStore();
    const backup = await exportBackup(store, '0.1.0', 9999);

    expect(backup.data.boards).toHaveLength(1);
    expect(backup.data.sessions).toHaveLength(1);
    expect(backup.data.events).toHaveLength(2);
    expect(backup.data.attachments).toHaveLength(1);
    expect(backup.appVersion).toBe('0.1.0');
  });

  it('★ 导出里没有 API Key', async () => {
    const store = await seededStore();
    const backup = await exportBackup(store, '0.1.0', 9999);

    expect(backup.data.meta.map((m) => m.key)).not.toContain('credential:ch-1');
    expect(JSON.stringify(backup)).not.toContain('sk-secret');
  });

  it('截图以 base64 形式带进去', async () => {
    const store = await seededStore();
    const backup = await exportBackup(store, '0.1.0', 9999);
    expect(backup.data.attachments[0]?.base64).toBe(btoa('\u0001\u0002\u0003\u0004'));
  });
});

describe('导出 → 导入 往返', () => {
  it('★ 导进一个空库，数据一模一样（二进制也一样）', async () => {
    const source = await seededStore();
    const backup = await exportBackup(source, '0.1.0', 9999);

    const target = new MemoryStore();
    await target.init();
    await importBackup(target, parseBackup(JSON.stringify(backup)));

    expect((await target.listBoards()).map((b) => b.title)).toEqual(['一元二次方程']);
    expect(await target.loadEvents('b1')).toHaveLength(2);
    expect(await target.countUnsynced()).toBe(2);
    expect((await target.lastSession())?.id).toBe('s1');

    const attachment = await target.getAttachment('a1');
    expect(attachment).not.toBeNull();
    expect(new Uint8Array(await attachment!.blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );

    // 板外设置也回来了
    expect(await target.getMeta('deviceId')).toBe('dev-abc');
  });

  it('★ 导入是幂等的 —— 同一个文件导两次，数据不会翻倍', async () => {
    const source = await seededStore();
    const backup = await exportBackup(source, '0.1.0', 9999);

    const target = new MemoryStore();
    await target.init();
    await importBackup(target, backup);
    await importBackup(target, backup);
    await importBackup(target, backup);

    // 事件按 id 去重，所以还是 2 条
    expect(await target.loadEvents('b1')).toHaveLength(2);
    expect(await target.listBoards()).toHaveLength(1);
    expect(await target.listAttachments('b1')).toHaveLength(1);

    // 这个性质是 M6 同步的地基：推拉日志不会因为重试而长出重复数据
  });

  it('★ 导入一个来路不明的备份，不会装进别人的 Key', async () => {
    const target = new MemoryStore();
    await target.init();
    await target.setMeta('credential:ch-1', { type: 'api_key', key: '本机自己的-key' });

    // 手工构造一个"里面带凭据"的备份（正常导出不会有，但用户可能从别处拿到）
    const backup = parseBackup(
      JSON.stringify({
        format: 'teach-learn-whiteboard-backup',
        version: 1,
        exportedAt: 0,
        appVersion: 'x',
        data: {
          boards: [], sessions: [], events: [], attachments: [],
          meta: [
            { key: 'credential:ch-1', value: { type: 'api_key', key: '别人的-key' } },
            { key: 'deviceId', value: '来自外部的' },
          ],
        },
      }),
    );

    await importBackup(target, backup);

    // 本机原有的 Key 没被换掉
    expect(await target.getMeta('credential:ch-1')).toEqual({
      type: 'api_key',
      key: '本机自己的-key',
    });
    // 但普通设置照常导入
    expect(await target.getMeta('deviceId')).toBe('来自外部的');
  });

  it('★★ 本机没有的凭据也**不**导入 —— 否则等于让别人的 Key 接管你的请求', async () => {
    const target = new MemoryStore();
    await target.init();

    const backup = parseBackup(
      JSON.stringify({
        format: 'teach-learn-whiteboard-backup',
        version: 1,
        exportedAt: 0,
        appVersion: 'x',
        data: {
          boards: [], sessions: [], events: [], attachments: [],
          meta: [{ key: 'credential:ch-2', value: { type: 'api_key', key: '陌生人的-key' } }],
        },
      }),
    );

    const summary = await importBackup(target, backup);

    // 没有装进去 —— 我们自己的导出本来就不含 Key，所以它只可能来自伪造
    expect(await target.getMeta('credential:ch-2')).toBeNull();
    expect(summary.meta).toBe(0);
  });

  it('导入摘要报出各类数量', async () => {
    const source = await seededStore();
    const backup = await exportBackup(source, '0.1.0', 9999);
    const target = new MemoryStore();
    await target.init();

    const summary = await importBackup(target, backup);
    expect(summary.boards).toBe(1);
    expect(summary.sessions).toBe(1);
    expect(summary.events).toBe(2);
    expect(summary.attachments).toBe(1);
  });

  it('附件记录在、文件丢了 —— 跳过它，不让整个导出失败', async () => {
    const store = await seededStore();
    await store.deleteAttachment('a1');
    const backup = await exportBackup(store, '0.1.0', 9999);
    expect(backup.data.attachments).toHaveLength(0);
    expect(backup.data.events).toHaveLength(2);
  });
});
