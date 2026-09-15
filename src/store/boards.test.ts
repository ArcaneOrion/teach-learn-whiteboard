/**
 * 板列表对账与「启动开哪块板」的测试
 *
 * 这两个都是被真实场景逼出来的：
 *   · 同步把事件拉回来了，但那块板在界面上不出现（boards 表里没有它）
 *   · 同步完了，用户看到的却是一块刚建的空板
 */

import { describe, expect, it } from 'vitest';

import type { BoardEvent } from '../core/types';
import { MemoryStore } from './memoryStore';
import { countContentEvents, deriveBoard, pickStartupBoard, reconcileBoards } from './boards';

function ev(over: Partial<BoardEvent> & { id: string; boardId: string; kind: BoardEvent['kind'] }): BoardEvent {
  return {
    sessionId: 's1',
    seq: 1,
    actor: 'user',
    payload: null,
    createdAt: 1000,
    deviceId: 'dev',
    synced: 0,
    ...over,
  } as BoardEvent;
}

describe('deriveBoard', () => {
  it('从事件里推出标题和起止时间', () => {
    const board = deriveBoard('b1', [
      ev({ id: 'e1', boardId: 'b1', kind: 'board.create', payload: { title: '一元二次方程' }, createdAt: 100 }),
      ev({ id: 'e2', boardId: 'b1', kind: 'ink.clear', createdAt: 900 }),
    ]);
    expect(board.id).toBe('b1');
    expect(board.title).toBe('一元二次方程');
    expect(board.createdAt).toBe(100);
    expect(board.updatedAt).toBe(900);
  });

  it('没有 board.create 事件时用「未命名」兜底', () => {
    const board = deriveBoard('b1', [ev({ id: 'e1', boardId: 'b1', kind: 'ink.clear', createdAt: 500 })]);
    expect(board.title).toBe('未命名');
    expect(board.updatedAt).toBe(500);
  });

  it('★ 标题取「最后一条 create 或 rename」—— 改了名之后列表也得跟着变', () => {
    const board = deriveBoard('b1', [
      ev({ id: 'e1', boardId: 'b1', kind: 'board.create', payload: { title: '未命名' }, createdAt: 100 }),
      ev({ id: 'e2', boardId: 'b1', kind: 'board.rename', payload: { title: '一元二次方程' }, createdAt: 200 }),
    ]);
    expect(board.title).toBe('一元二次方程');
  });

  it('改名事件乱序到达时，仍然按时间取最后那条', () => {
    const events = [
      ev({ id: 'e1', boardId: 'b1', kind: 'board.create', payload: { title: '一' }, createdAt: 100 }),
      ev({ id: 'e2', boardId: 'b1', kind: 'board.rename', payload: { title: '二' }, createdAt: 200 }),
      ev({ id: 'e3', boardId: 'b1', kind: 'board.rename', payload: { title: '三' }, createdAt: 300 }),
    ];
    expect(deriveBoard('b1', events).title).toBe('三');
    expect(deriveBoard('b1', [...events].reverse()).title).toBe('三');
  });

  it('只有 rename、没有 create 也能推出标题', () => {
    const board = deriveBoard('b1', [
      ev({ id: 'e1', boardId: 'b1', kind: 'board.rename', payload: { title: '后来起的名' }, createdAt: 100 }),
    ]);
    expect(board.title).toBe('后来起的名');
  });

  it('只认这块板的事件', () => {
    const board = deriveBoard('b1', [
      ev({ id: 'e1', boardId: 'b1', kind: 'board.create', payload: { title: '我的' }, createdAt: 100 }),
      ev({ id: 'e2', boardId: 'b2', kind: 'board.create', payload: { title: '别人的' }, createdAt: 999 }),
    ]);
    expect(board.title).toBe('我的');
    expect(board.updatedAt).toBe(100);
  });
});

describe('reconcileBoards', () => {
  it('★ 有事件但没有板记录时补出来（同步拉回来的板）', async () => {
    const store = new MemoryStore();
    await store.init();
    await store.appendEvents([
      ev({ id: 'e1', boardId: 'pulled', kind: 'board.create', payload: { title: '别人写的' } }),
      ev({ id: 'e2', boardId: 'pulled', kind: 'ink.clear' }),
    ]);

    expect(await store.listBoards()).toHaveLength(0);
    expect(await reconcileBoards(store)).toBe(1);

    const boards = await store.listBoards();
    expect(boards[0]?.id).toBe('pulled');
    expect(boards[0]?.title).toBe('别人写的');
  });

  it('已经有了就不动它（不覆盖本地已有的信息）', async () => {
    const store = new MemoryStore();
    await store.init();
    await store.appendEvents([ev({ id: 'e1', boardId: 'b1', kind: 'ink.clear' })]);
    await store.putBoard({
      id: 'b1', userId: 'local', title: '我改过的名字', createdAt: 1, updatedAt: 1, archived: 0,
    });

    expect(await reconcileBoards(store)).toBe(0);
    expect((await store.listBoards())[0]?.title).toBe('我改过的名字');
  });

  it('没有任何事件时什么都不做', async () => {
    const store = new MemoryStore();
    await store.init();
    expect(await reconcileBoards(store)).toBe(0);
  });

  it('多块板一起补', async () => {
    const store = new MemoryStore();
    await store.init();
    await store.appendEvents([
      ev({ id: 'e1', boardId: 'b1', kind: 'ink.clear' }),
      ev({ id: 'e2', boardId: 'b2', kind: 'ink.clear' }),
    ]);
    expect(await reconcileBoards(store)).toBe(2);
  });
});

describe('countContentEvents', () => {
  it('board.create 不算实质内容', () => {
    expect(countContentEvents([ev({ id: 'e1', boardId: 'b1', kind: 'board.create' })])).toBe(0);
  });

  it('其它事件都算', () => {
    expect(
      countContentEvents([
        ev({ id: 'e1', boardId: 'b1', kind: 'board.create' }),
        ev({ id: 'e2', boardId: 'b1', kind: 'ink.clear' }),
        ev({ id: 'e3', boardId: 'b1', kind: 'user.say', payload: { text: 'x' } }),
      ]),
    ).toBe(2);
  });
});

describe('pickStartupBoard', () => {
  const boards = [{ id: 'empty-new' }, { id: 'worked-on' }, { id: 'old' }];

  it('★ 优先选有实质内容的板 —— 哪怕它不是最新的', () => {
    // empty-new 是刚建的空板（只有 board.create），不该被选中
    const counts: Record<string, number> = { 'empty-new': 0, 'worked-on': 3, old: 1 };
    expect(pickStartupBoard(boards, (id) => counts[id] ?? 0)?.id).toBe('worked-on');
  });

  it('全都没有内容时退回最近更新的那块', () => {
    expect(pickStartupBoard(boards, () => 0)?.id).toBe('empty-new');
  });

  it('一块板都没有时返回 null', () => {
    expect(pickStartupBoard([], () => 0)).toBeNull();
  });

  it('★ 同步完之后的场景：新空板不该抢走视线', () => {
    // 清空 → 同步 → 拉回来一块有内容的板；同时本机刚建了一块空的
    const after = [{ id: 'just-created' }, { id: 'restored-from-sync' }];
    const counts: Record<string, number> = { 'just-created': 0, 'restored-from-sync': 18 };
    expect(pickStartupBoard(after, (id) => counts[id] ?? 0)?.id).toBe('restored-from-sync');
  });
});
