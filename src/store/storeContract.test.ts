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
import type { AttachmentRecord, BoardRecord, ChunkRecord, DocRecord, Store } from './types';
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

function attachment(over: Partial<AttachmentRecord> & { id: string }): AttachmentRecord {
  return {
    userId: 'local',
    sessionId: 's1',
    boardId: 'b1',
    kind: 'snapshot',
    mime: 'image/png',
    bytes: 0,
    width: 800,
    height: 600,
    caption: null,
    createdAt: 1000,
    ...over,
  };
}

function doc(over: Partial<DocRecord> & { id: string }): DocRecord {
  return {
    userId: 'local',
    title: '示例资料',
    fileName: 'sample.txt',
    mime: 'text/plain',
    chars: 100,
    chunkCount: 1,
    importedAt: 1000,
    ...over,
  };
}

function chunk(over: Partial<ChunkRecord> & { id: string; docId: string; ord: number }): ChunkRecord {
  return {
    heading: null,
    page: null,
    text: `第 ${over.ord} 块`,
    start: 0,
    end: 10,
    ...over,
  };
}

/** 一套契约，两个实现都跑 */function storeContract(name: string, make: () => Promise<Store>): void {
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

    it('★ 删板要连它的事件和截图一起删 —— 否则留下永远清不掉的孤儿', async () => {
      await store.putBoard(board({ id: 'b1' }));
      await store.putBoard(board({ id: 'b2' }));
      await store.appendEvents([
        event({ id: 'e1', seq: 1, boardId: 'b1' }),
        event({ id: 'e2', seq: 1, boardId: 'b2' }),
      ]);
      await store.putAttachment(attachment({ id: 'a1', boardId: 'b1' }), new Blob(['x']));
      await store.putAttachment(attachment({ id: 'a2', boardId: 'b2' }), new Blob(['y']));

      await store.deleteBoard('b1');

      expect(await store.getBoard('b1')).toBeNull();
      expect(await store.loadEvents('b1')).toHaveLength(0);
      expect(await store.getAttachment('a1')).toBeNull();

      // 别的板一点都不受影响
      expect(await store.getBoard('b2')).not.toBeNull();
      expect(await store.loadEvents('b2')).toHaveLength(1);
      expect(await store.getAttachment('a2')).not.toBeNull();
    });

    it('删不存在的板不报错', async () => {
      await expect(store.deleteBoard('nope')).resolves.toBeUndefined();
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

    // ── 附件 ──────────────────────────────────────────────────

    it('★ 附件能带着二进制原样存取', async () => {
      const blob = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' });
      await store.putAttachment(attachment({ id: 'a1', bytes: blob.size }), blob);

      const got = await store.getAttachment('a1');
      expect(got).not.toBeNull();
      expect(got?.record.mime).toBe('image/png');
      expect(got?.blob.size).toBe(blob.size);
      // 二进制内容要一致，不能变成别的东西
      expect(new Uint8Array(await got!.blob.arrayBuffer())).toEqual(
        new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
      );
    });

    it('读不存在的附件返回 null', async () => {
      expect(await store.getAttachment('nope')).toBeNull();
    });

    it('附件列表按创建时间倒序，且只列指定板的', async () => {
      const blob = new Blob(['x']);
      await store.putAttachment(attachment({ id: 'a1', boardId: 'b1', createdAt: 1000 }), blob);
      await store.putAttachment(attachment({ id: 'a2', boardId: 'b1', createdAt: 3000 }), blob);
      await store.putAttachment(attachment({ id: 'a3', boardId: 'b2', createdAt: 2000 }), blob);

      expect((await store.listAttachments('b1')).map((a) => a.id)).toEqual(['a2', 'a1']);
      expect((await store.listAttachments('b2')).map((a) => a.id)).toEqual(['a3']);
    });

    it('删除附件之后读不到', async () => {
      await store.putAttachment(attachment({ id: 'a1' }), new Blob(['x']));
      await store.deleteAttachment('a1');
      expect(await store.getAttachment('a1')).toBeNull();
    });

    it('统计附件占用字节', async () => {
      await store.putAttachment(attachment({ id: 'a1', bytes: 100 }), new Blob(['x']));
      await store.putAttachment(attachment({ id: 'a2', bytes: 250 }), new Blob(['y']));
      expect(await store.attachmentBytes()).toBe(350);
    });

    it('附件里存了文字（caption），这对将来的检索很重要', async () => {
      await store.putAttachment(
        attachment({ id: 'a1', caption: '用户在判别式上画了个圈' }),
        new Blob(['x']),
      );
      expect((await store.getAttachment('a1'))?.record.caption).toBe('用户在判别式上画了个圈');
    });

    // ── 已同步标记（同步的地基）──────────────────────────────

    it('★ 重复写入同一个事件，不会把 synced 标志冲掉', async () => {
      const e = event({ id: 'e1', seq: 1, synced: 0 });
      await store.appendEvents([e]);
      await store.markSynced(['e1']);
      expect(await store.countUnsynced()).toBe(0);

      /**
       * 模拟同步的真实顺序：先标记已同步，再写入服务端回传的那批。
       * 服务端只是原样存了客户端发过去的内容，所以它回传的 `synced` **永远是 0**。
       *
       * 这里如果用无条件的 put，标记就被冲回 0 了 ——
       * 后果是**每次同步都把全部历史重推一遍**，笔记越多越夸张。
       * （内存实现本来就不覆盖，所以这个 bug 只在 IndexedDB 上出现，
       *   而同步的测试全用内存实现跑 —— 契约测试现在盯着它。）
       */
      await store.appendEvents([{ ...e, synced: 0 }]);

      expect(await store.countUnsynced()).toBe(0);
      expect((await store.loadEvents('b1'))[0]?.synced).toBe(1);
    });

    it('★ 重复写入不会改动事件内容（事件不可变）', async () => {
      await store.appendEvents([event({ id: 'e1', seq: 1, payload: { text: '原来的' } })]);
      await store.appendEvents([
        event({ id: 'e1', seq: 1, payload: { text: '被改过的' }, synced: 1 }),
      ]);

      const rows = await store.loadEvents('b1');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual({ text: '原来的' });
    });

    it('标记已同步之后 countUnsynced 归零', async () => {
      await store.appendEvents([event({ id: 'e1', seq: 1 }), event({ id: 'e2', seq: 2 })]);
      expect(await store.countUnsynced()).toBe(2);

      await store.markSynced(['e1']);
      expect(await store.countUnsynced()).toBe(1);

      await store.markSynced(['e2']);
      expect(await store.countUnsynced()).toBe(0);
    });

    it('markSynced 传不存在的 id / 空数组都不报错', async () => {
      await expect(store.markSynced(['不存在'])).resolves.toBeUndefined();
      await expect(store.markSynced([])).resolves.toBeUndefined();
    });

    // ── 资料（RAG）────────────────────────────────────────────

    it('★ 资料与它的块能存能取', async () => {
      await store.putDoc(doc({ id: 'd1', title: '代数课本', chunkCount: 2 }));
      await store.putChunks('d1', [
        chunk({ id: 'c1', docId: 'd1', ord: 0, text: '第一块' }),
        chunk({ id: 'c2', docId: 'd1', ord: 1, text: '第二块' }),
      ]);

      expect((await store.getDoc('d1'))?.title).toBe('代数课本');
      expect(await store.countChunks()).toBe(2);
      expect((await store.allChunks()).map((c) => c.text)).toEqual(['第一块', '第二块']);
    });

    it('资料列表按导入时间倒序', async () => {
      await store.putDoc(doc({ id: 'old', importedAt: 1000 }));
      await store.putDoc(doc({ id: 'new', importedAt: 3000 }));
      expect((await store.listDocs()).map((d) => d.id)).toEqual(['new', 'old']);
    });

    it('读不存在的资料返回 null', async () => {
      expect(await store.getDoc('nope')).toBeNull();
    });

    it('★ 删除资料会**连它的块一起删** —— 否则留下永远检索不到也删不掉的垃圾', async () => {
      await store.putDoc(doc({ id: 'd1' }));
      await store.putDoc(doc({ id: 'd2' }));
      await store.putChunks('d1', [
        chunk({ id: 'c1', docId: 'd1', ord: 0 }),
        chunk({ id: 'c2', docId: 'd1', ord: 1 }),
      ]);
      await store.putChunks('d2', [chunk({ id: 'c3', docId: 'd2', ord: 0 })]);

      await store.deleteDoc('d1');

      expect(await store.getDoc('d1')).toBeNull();
      expect(await store.countChunks()).toBe(1);
      expect((await store.allChunks())[0]?.docId).toBe('d2');
    });

    it('★ 重新导入会覆盖原来的块，不会新旧混在一起', async () => {
      await store.putDoc(doc({ id: 'd1' }));
      await store.putChunks('d1', [
        chunk({ id: 'old-1', docId: 'd1', ord: 0 }),
        chunk({ id: 'old-2', docId: 'd1', ord: 1 }),
      ]);
      await store.putChunks('d1', [chunk({ id: 'new-1', docId: 'd1', ord: 0 })]);

      expect(await store.countChunks()).toBe(1);
      expect((await store.allChunks())[0]?.id).toBe('new-1');
    });

    it('★ 覆盖只影响这一份文档，别的文档的块不动', async () => {
      await store.putChunks('d1', [chunk({ id: 'c1', docId: 'd1', ord: 0 })]);
      await store.putChunks('d2', [chunk({ id: 'c2', docId: 'd2', ord: 0 })]);
      await store.putChunks('d1', [chunk({ id: 'c1b', docId: 'd1', ord: 0 })]);

      expect(await store.countChunks()).toBe(2);
      expect((await store.allChunks()).map((c) => c.id).sort()).toEqual(['c1b', 'c2']);
    });

    it('clear 也清资料', async () => {
      await store.putDoc(doc({ id: 'd1' }));
      await store.putChunks('d1', [chunk({ id: 'c1', docId: 'd1', ord: 0 })]);
      await store.clear();
      expect(await store.listDocs()).toHaveLength(0);
      expect(await store.countChunks()).toBe(0);
    });

    // ── clear ─────────────────────────────────────────────────

    it('clear 清空一切', async () => {
      await store.appendEvents([event({ id: 'e1', seq: 1 })]);
      await store.putBoard(board({ id: 'b1' }));
      await store.putSession(session({ id: 's1' }));
      await store.putAttachment(attachment({ id: 'a1' }), new Blob(['x']));
      await store.setMeta('k', 'v');

      await store.clear();

      expect(await store.loadEvents('b1')).toHaveLength(0);
      expect(await store.getBoard('b1')).toBeNull();
      expect(await store.lastSession()).toBeNull();
      expect(await store.getAttachment('a1')).toBeNull();
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
