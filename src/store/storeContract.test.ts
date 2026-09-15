/**
 * 两个存储实现共用同一套测试
 *
 * 为什么这么写：内存实现和 IndexedDB 实现如果行为不一致，就会出现
 * 「单元测试全绿、真机上数据丢失」这种最难查的问题。
 * 所以把测试写成一份契约，两边都跑。
 */

import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { BoardEvent } from '../core/types';
import type { SessionRecord } from '../core/session';
import type { BoardRecord, Store } from './types';
import { MemoryStore } from './memoryStore';
import { IndexedDbStore } from './indexedDbStore';

function event(over: Partial<BoardEvent> & { id: string; seq: number }): BoardEvent {
  return {
    boardId: 'b1',
    sessionId: 's1',
    actor: 'user',
    kind: 'ink.clear',
    payload: null,
    createdAt: 1000 + over.seq,
    deviceId: 'dev-A',
    synced: 0,
    ...over,
  } as BoardEvent;
}

function board(over: Partial<BoardRecord> & { id: string }): BoardRecord {
  return {
    userId: 'local',
    title: '未命名',
    createdAt: 1000,
    updatedAt: 1000,
    archived: 0,
    ...over,
  };
}

function session(over: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    userId: 'local',
    title: null,
    startedAt: 1000,
    endedAt: null,
    lastActive: 1000,
    deviceId: 'dev-A',
    ...over,
  };
}

/** 一套契约，两个实现都跑 */
function storeContract(name: string, make: () => Promise<Store>): void {
  describe(name, () => {
    let store: Store;

    beforeEach(async () => {
      store = await make();
      await store.clear();
    });

    // ── 事件 ──────────────────────────────────────────────────

    it('写入的事件能读回来', async () => {
      await store.appendEvents([event({ id: 'e1', seq: 1 })]);
      const rows = await store.loadEvents('b1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe('e1');
    });

    it('★ 读回来的顺序按 seq 升序，与写入顺序无关', async () => {
      await store.appendEvents([
        event({ id: 'e3', seq: 3 }),
        event({ id: 'e1', seq: 1 }),
        event({ id: 'e2', seq: 2 }),
      ]);
      const rows = await store.loadEvents('b1');
      expect(rows.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it('只读出指定板的事件，别的板不会串进来', async () => {
      await store.appendEvents([
        event({ id: 'e1', seq: 1, boardId: 'b1' }),
        event({ id: 'e2', seq: 1, boardId: 'b2' }),
      ]);
      expect(await store.loadEvents('b1')).toHaveLength(1);
      expect(await store.loadEvents('b2')).toHaveLength(1);
      expect(await store.loadEvents('b3')).toHaveLength(0);
    });

    it('★ 同一个 id 重复写入是幂等的（便于失败重试）', async () => {
      const e = event({ id: 'e1', seq: 1 });
      await store.appendEvents([e]);
      await store.appendEvents([e]);
      await store.appendEvents([e]);
      expect(await store.loadEvents('b1')).toHaveLength(1);
    });

    it('空数组写入不出错', async () => {
      await store.appendEvents([]);
      expect(await store.loadEvents('b1')).toHaveLength(0);
    });

    it('复杂的事件（含笔迹点数组）能原样存取', async () => {
      const full = event({
        id: 'e1',
        seq: 1,
        kind: 'ink.stroke',
        payload: {
          stroke: {
            id: 's1',
            color: '#e5484d',
            size: 4,
            erase: false,
            source: 'pen',
            points: [
              { x: 1.5, y: 2.5, pressure: 0.42, t: 1700000000000 },
              { x: 3, y: 4, pressure: 0.9, t: 1700000000016 },
            ],
          },
        },
      } as Partial<BoardEvent> & { id: string; seq: number });

      await store.appendEvents([full]);
      const rows = await store.loadEvents('b1');
      expect(rows[0]).toEqual(full);
    });

    it('统计未同步的事件数', async () => {
      await store.appendEvents([
        event({ id: 'e1', seq: 1, synced: 0 }),
        event({ id: 'e2', seq: 2, synced: 1 }),
        event({ id: 'e3', seq: 3, synced: 0 }),
      ]);
      expect(await store.countUnsynced()).toBe(2);
    });

    // ── 板 ────────────────────────────────────────────────────

    it('板的读写与覆盖', async () => {
      await store.putBoard(board({ id: 'b1', title: '一元二次方程' }));
      expect((await store.getBoard('b1'))?.title).toBe('一元二次方程');

      await store.putBoard(board({ id: 'b1', title: '改过了', updatedAt: 2000 }));
      const one = await store.getBoard('b1');
      expect(one?.title).toBe('改过了');
      expect(await store.listBoards()).toHaveLength(1);
    });

    it('读不存在的板返回 null', async () => {
      expect(await store.getBoard('nope')).toBeNull();
    });

    it('板列表按最近更新倒序', async () => {
      await store.putBoard(board({ id: 'old', updatedAt: 1000 }));
      await store.putBoard(board({ id: 'new', updatedAt: 3000 }));
      await store.putBoard(board({ id: 'mid', updatedAt: 2000 }));
      expect((await store.listBoards()).map((b) => b.id)).toEqual(['new', 'mid', 'old']);
    });

    // ── 会话 ──────────────────────────────────────────────────

    it('会话的读写与列表', async () => {
      await store.putSession(session({ id: 's1', startedAt: 1000 }));
      await store.putSession(session({ id: 's2', startedAt: 3000 }));
      await store.putSession(session({ id: 's3', startedAt: 2000 }));

      expect((await store.getSession('s2'))?.id).toBe('s2');
      expect((await store.listSessions()).map((s) => s.id)).toEqual(['s2', 's3', 's1']);
    });

    it('★ lastSession 返回开始时间最晚的那条', async () => {
      expect(await store.lastSession()).toBeNull();
      await store.putSession(session({ id: 's1', startedAt: 1000 }));
      await store.putSession(session({ id: 's2', startedAt: 5000 }));
      await store.putSession(session({ id: 's3', startedAt: 3000 }));
      expect((await store.lastSession())?.id).toBe('s2');
    });

    it('更新会话（补结束时间）后读回来是新值', async () => {
      await store.putSession(session({ id: 's1' }));
      await store.putSession(session({ id: 's1', endedAt: 9999, lastActive: 9000 }));
      const one = await store.getSession('s1');
      expect(one?.endedAt).toBe(9999);
      expect(one?.lastActive).toBe(9000);
    });

    // ── meta ──────────────────────────────────────────────────

    it('meta 存取值，读不存在的键返回 null', async () => {
      expect(await store.getMeta<string>('deviceId')).toBeNull();
      await store.setMeta('deviceId', 'dev-abc');
      expect(await store.getMeta<string>('deviceId')).toBe('dev-abc');
    });

    it('meta 支持对象', async () => {
      await store.setMeta('config', { a: 1, b: [1, 2] });
      expect(await store.getMeta<{ a: number }>('config')).toEqual({ a: 1, b: [1, 2] });
    });

    // ── clear ─────────────────────────────────────────────────

    it('clear 清空一切', async () => {
      await store.appendEvents([event({ id: 'e1', seq: 1 })]);
      await store.putBoard(board({ id: 'b1' }));
      await store.putSession(session({ id: 's1' }));
      await store.setMeta('k', 'v');

      await store.clear();

      expect(await store.loadEvents('b1')).toHaveLength(0);
      expect(await store.getBoard('b1')).toBeNull();
      expect(await store.lastSession()).toBeNull();
      expect(await store.getMeta('k')).toBeNull();
    });
  });
}

storeContract('MemoryStore', async () => {
  const s = new MemoryStore();
  await s.init();
  return s;
});

storeContract('IndexedDbStore', async () => {
  const s = new IndexedDbStore();
  await s.init();
  return s;
});

describe('Store 的公共约束', () => {
  it('没 init() 就用会明确报错，而不是静默出错', async () => {
    const s = new IndexedDbStore();
    await expect(s.loadEvents('b1')).rejects.toThrow(/init/);
  });
});
