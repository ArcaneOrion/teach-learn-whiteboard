/**
 * 同步引擎的测试 —— **两台设备真的对上**
 *
 * 这是 M6 的验收测试（技术文档 §18）：
 * **两台设备折叠出来的板面必须完全一致。**
 *
 * 用两个 MemoryStore 当两台设备、一个 MemorySyncServer 当服务端，
 * 不碰网络 —— 所以它验的是**协议逻辑**，不是 HTTP（那个另外测）。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Stroke } from '../ink/strokes';
import { EventLog } from '../core/events';
import { composeBoard } from '../core/board';
import { MemoryStore } from '../store/memoryStore';
import { MemorySyncServer, MemoryTransport } from './memoryTransport';
import { readCursor, runSync } from './syncEngine';

function stroke(id: string): Stroke {
  return {
    id,
    color: '#1f2328',
    size: 4,
    erase: false,
    source: 'pen',
    points: [
      { x: 0, y: 0, pressure: 0.5, t: 0 },
      { x: 10, y: 10, pressure: 0.5, t: 16 },
    ],
  };
}

/** 一台"设备"：一个存储 + 一个日志 */
async function makeDevice(deviceId: string) {
  const store = new MemoryStore();
  await store.init();
  const log = new EventLog({ boardId: 'b1', sessionId: `s-${deviceId}`, deviceId });
  return { store, log, deviceId };
}

describe('两台设备同步', () => {
  let server: MemorySyncServer;
  let transport: MemoryTransport;

  beforeEach(() => {
    server = new MemorySyncServer();
    transport = new MemoryTransport(server);
  });

  it('A 写的东西，B 能拿到', async () => {
    const A = await makeDevice('dev-A');
    A.log.createBoard('一元二次方程');
    A.log.aiWrite({ op: 'append', html: '<p>A 写的</p>', region: 'a' });
    await A.store.appendEvents(A.log.all);

    await runSync({ store: A.store, transport, deviceId: A.deviceId });
    expect(server.size).toBe(2);

    const B = await makeDevice('dev-B');
    const result = await runSync({ store: B.store, transport, deviceId: B.deviceId });

    expect(result.merged).toBe(2);
    expect((await B.store.loadEvents('b1')).map((e) => e.kind)).toEqual([
      'board.create',
      'ai.write',
    ]);
  });

  it('★ 两边各写各的之后，折叠出来的板面**完全一致**', async () => {
    const A = await makeDevice('dev-A');
    const B = await makeDevice('dev-B');

    // A 先建板并写一块
    A.log.createBoard('A 建的板');
    A.log.aiWrite({ op: 'append', html: '<p>A 的第一块</p>', region: 'a1' });
    await A.store.appendEvents(A.log.all);
    await runSync({ store: A.store, transport, deviceId: A.deviceId });

    // B 同步下来
    await runSync({ store: B.store, transport, deviceId: B.deviceId });

    // ★ B 在**离线状态**下也建板、也写东西 —— seq 会和 A 撞号
    B.log.createBoard('B 也在建板');
    B.log.aiWrite({ op: 'append', html: '<p>B 的一块</p>', region: 'b1' });
    B.log.writeStroke(stroke('s-b'));
    await B.store.appendEvents(B.log.all);

    // B 推上去，A 再拉回来
    await runSync({ store: B.store, transport, deviceId: B.deviceId });
    await runSync({ store: A.store, transport, deviceId: A.deviceId });

    // 两台设备现在应该有同样的事件集合
    const eventsA = await A.store.allEvents();
    const eventsB = await B.store.allEvents();
    expect(eventsA.map((e) => e.id)).toEqual(eventsB.map((e) => e.id));

    // ★ 而且折叠出来的板面一模一样（seq 撞号时靠 (时间, 设备号) 定序）
    expect(composeBoard('b1', eventsA)).toEqual(composeBoard('b1', eventsB));

    // 板面上两块都在
    const state = composeBoard('b1', eventsA);
    expect(state.blocks.map((b) => b.region).sort()).toEqual(['a1', 'b1']);
    expect(state.strokes.map((s) => s.id)).toEqual(['s-b']);
  });

  it('★ 反复同步不会长出重复数据（幂等）', async () => {
    const A = await makeDevice('dev-A');
    A.log.createBoard('板');
    A.log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    await A.store.appendEvents(A.log.all);

    for (let i = 0; i < 5; i += 1) {
      await runSync({ store: A.store, transport, deviceId: A.deviceId });
    }

    expect(await A.store.allEvents()).toHaveLength(2);
    expect(server.size).toBe(2);
  });

  it('推上去之后本地事件被标成已同步，第二次同步不再重复推', async () => {
    const A = await makeDevice('dev-A');
    A.log.createBoard('板');
    await A.store.appendEvents(A.log.all);

    const first = await runSync({ store: A.store, transport, deviceId: A.deviceId });
    expect(first.pushed).toBe(1);
    expect(await A.store.countUnsynced()).toBe(0);

    const second = await runSync({ store: A.store, transport, deviceId: A.deviceId });
    expect(second.pushed).toBe(0);
    expect(second.merged).toBe(0);
  });

  it('★ 拉了两次不会把服务端的事件重复合并进来', async () => {
    const A = await makeDevice('dev-A');
    A.log.createBoard('板');
    A.log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    await A.store.appendEvents(A.log.all);
    await runSync({ store: A.store, transport, deviceId: A.deviceId });

    const B = await makeDevice('dev-B');
    const first = await runSync({ store: B.store, transport, deviceId: B.deviceId });
    expect(first.merged).toBe(2);

    // 第二次：游标已经推进，服务端不会再给我们这批
    const second = await runSync({ store: B.store, transport, deviceId: B.deviceId });
    expect(second.merged).toBe(0);
    expect(await B.store.allEvents()).toHaveLength(2);
  });

  it('游标会存下来，第二次同步接着上次的位置', async () => {
    const A = await makeDevice('dev-A');
    A.log.createBoard('板');
    await A.store.appendEvents(A.log.all);

    expect(await readCursor(A.store)).toBeNull();
    await runSync({ store: A.store, transport, deviceId: A.deviceId });

    const cursor = await readCursor(A.store);
    expect(cursor).not.toBeNull();
    expect(cursor?.deviceId).toBe('dev-A');
  });

  it('★ 服务端清空之后（换服务器/重装），本机数据不会丢', async () => {
    const A = await makeDevice('dev-A');
    A.log.createBoard('板');
    A.log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    await A.store.appendEvents(A.log.all);
    await runSync({ store: A.store, transport, deviceId: A.deviceId });

    server.reset();

    // 本机仍然有全部事件（只是都标成了已同步）
    expect(await A.store.allEvents()).toHaveLength(2);

    // 下一次同步：因为没有未同步的事件，服务端还是空的。
    // 这符合预期 —— 但**这提醒我们**：服务端是中心，要自己做好备份。
    await runSync({ store: A.store, transport, deviceId: A.deviceId });
    expect(server.size).toBe(0);
    expect(await A.store.allEvents()).toHaveLength(2);
  });

  it('★ 拉到了别人板上的事件时，会顺便把那块板的记录补出来', async () => {
    // 不补的话：事件全在库里，但那块板在界面上**永远不出现**
    const A = await makeDevice('dev-A');
    A.log.createBoard('A 的板');
    A.log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a1' });
    await A.store.appendEvents(A.log.all);
    await runSync({ store: A.store, transport, deviceId: A.deviceId });

    const B = await makeDevice('dev-B');
    expect(await B.store.listBoards()).toHaveLength(0);

    const result = await runSync({ store: B.store, transport, deviceId: B.deviceId });

    expect(result.boardsAdded).toBe(1);
    const boards = await B.store.listBoards();
    expect(boards).toHaveLength(1);
    expect(boards[0]?.id).toBe('b1');
    // 标题是从 board.create 事件里推出来的，不是瞎编的
    expect(boards[0]?.title).toBe('A 的板');
  });

  it('板记录已经存在时不会重复创建', async () => {
    const A = await makeDevice('dev-A');
    A.log.createBoard('板');
    await A.store.appendEvents(A.log.all);
    await A.store.putBoard({
      id: 'b1', userId: 'local', title: '已有的', createdAt: 1, updatedAt: 1, archived: 0,
    });

    const result = await runSync({ store: A.store, transport, deviceId: A.deviceId });
    expect(result.boardsAdded).toBe(0);
    expect((await A.store.listBoards())[0]?.title).toBe('已有的');
  });

  it('三台设备接力写，最后三方一致', async () => {
    const A = await makeDevice('dev-A');
    const B = await makeDevice('dev-B');
    const C = await makeDevice('dev-C');

    A.log.createBoard('板');
    await A.store.appendEvents(A.log.all);
    await runSync({ store: A.store, transport, deviceId: A.deviceId });

    await runSync({ store: B.store, transport, deviceId: B.deviceId });
    B.log.aiWrite({ op: 'append', html: '<p>B 写的</p>', region: 'b' });
    await B.store.appendEvents(B.log.all);
    await runSync({ store: B.store, transport, deviceId: B.deviceId });

    await runSync({ store: C.store, transport, deviceId: C.deviceId });
    C.log.writeStroke(stroke('s-c'));
    await C.store.appendEvents(C.log.all);
    await runSync({ store: C.store, transport, deviceId: C.deviceId });

    // 大家都拉一遍
    for (const device of [A, B, C]) {
      await runSync({ store: device.store, transport, deviceId: device.deviceId });
    }
    for (const device of [A, B, C]) {
      await runSync({ store: device.store, transport, deviceId: device.deviceId });
    }

    const states = await Promise.all(
      [A, B, C].map(async (d) => composeBoard('b1', await d.store.allEvents())),
    );
    expect(states[1]).toEqual(states[0]);
    expect(states[2]).toEqual(states[0]);
    expect(states[0]?.blocks.map((b) => b.region)).toEqual(['b']);
    expect(states[0]?.strokes).toHaveLength(1);
  });
});
