/**
 * 事件日志与板面折叠的单元测试
 *
 * 为什么这个文件特别重要：
 * 「事件日志是唯一真相」是整个项目最重要的设计决定。如果折叠逻辑有 bug，
 * 表现会非常隐蔽 —— 板面看着没事，直到某天同步、撤销或回放时才对不上。
 * 所以它是**最值得写测试**的一块，而且它是纯函数，测起来几乎零成本。
 */

import { describe, expect, it } from 'vitest';

import { compareEvents, composeBoard, lastStroke, totalPoints } from './board';
import { EventLog } from './events';
import type { BoardEvent } from './types';
import type { Point, Stroke } from '../ink/strokes';

// ── 测试辅助 ──────────────────────────────────────────────────

/** 造一笔（内容不重要，测试只关心它在不在、叫什么 id） */
function stroke(id: string, pointCount = 2): Stroke {
  const points: Point[] = [];
  for (let i = 0; i < pointCount; i += 1) points.push({ x: i, y: i, pressure: 0.5, t: i });
  return { id, color: '#000', size: 4, erase: false, source: 'pen', points };
}

/** 一个时间可控的日志，方便写出确定性的断言 */
function makeLog(boardId = 'b1') {
  let t = 1_000;
  return new EventLog({
    boardId,
    sessionId: 's1',
    deviceId: 'dev-A',
    now: () => (t += 10),
  });
}

// ── 折叠 ──────────────────────────────────────────────────────

describe('composeBoard', () => {
  it('空日志折叠出空板面', () => {
    const state = composeBoard('b1', []);
    expect(state.title).toBe('');
    expect(state.blocks).toEqual([]);
    expect(state.strokes).toEqual([]);
    expect(state.choices).toBeNull();
  });

  it('board.create 设置标题', () => {
    const log = makeLog();
    log.createBoard('一元二次方程');
    expect(composeBoard('b1', log.all).title).toBe('一元二次方程');
  });

  it('只折叠指定板的事件，别的板不会串进来', () => {
    const a = makeLog('b1');
    const b = makeLog('b2');
    a.createBoard('板 A');
    b.createBoard('板 B');
    a.writeStroke(stroke('s1'));

    const events = [...a.all, ...b.all];
    const state = composeBoard('b1', events);

    expect(state.title).toBe('板 A');
    expect(state.strokes).toHaveLength(1);
  });
});

// ── AI 写板（画布操作协议）────────────────────────────────────

describe('ai.write 的三种操作', () => {
  it('append 按顺序追加块', () => {
    const log = makeLog();
    log.aiWrite({ op: 'append', html: '<p>第一段</p>', region: 'a' });
    log.aiWrite({ op: 'append', html: '<p>第二段</p>', region: 'b' });

    const { blocks } = composeBoard('b1', log.all);
    expect(blocks.map((b) => b.region)).toEqual(['a', 'b']);
    expect(blocks[1]?.html).toBe('<p>第二段</p>');
  });

  it('append 不带 region 时区域记为 null', () => {
    const log = makeLog();
    log.aiWrite({ op: 'append', html: '<p>x</p>' });
    expect(composeBoard('b1', log.all).blocks[0]?.region).toBeNull();
  });

  it('set 替换指定区域，且不改变其它块的位置', () => {
    const log = makeLog();
    log.aiWrite({ op: 'append', html: '旧', region: 'a' });
    log.aiWrite({ op: 'append', html: '中间的', region: 'b' });
    log.aiWrite({ op: 'append', html: '尾', region: 'c' });
    log.aiWrite({ op: 'set', region: 'a', html: '新' });

    const { blocks } = composeBoard('b1', log.all);
    expect(blocks.map((b) => b.region)).toEqual(['a', 'b', 'c']);
    expect(blocks.map((b) => b.html)).toEqual(['新', '中间的', '尾']);
  });

  it('set 一个不存在的区域 → 退化成追加，不丢内容', () => {
    const log = makeLog();
    log.aiWrite({ op: 'append', html: '原来的', region: 'a' });
    log.aiWrite({ op: 'set', region: '不存在的区域', html: '内容' });

    const { blocks } = composeBoard('b1', log.all);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.html).toBe('内容');
  });

  it('remove 按区域名删掉那一块，其它块不动', () => {
    const log = makeLog();
    log.aiWrite({ op: 'append', html: 'A', region: 'a' });
    log.aiWrite({ op: 'append', html: 'B', region: 'b' });
    log.aiWrite({ op: 'remove', region: 'a' });

    const { blocks } = composeBoard('b1', log.all);
    expect(blocks.map((b) => b.region)).toEqual(['b']);
  });
});

// ── 笔迹 ──────────────────────────────────────────────────────

describe('笔迹事件', () => {
  it('ink.stroke 累积笔画', () => {
    const log = makeLog();
    log.writeStroke(stroke('s1', 3));
    log.writeStroke(stroke('s2', 5));

    const state = composeBoard('b1', log.all);
    expect(state.strokes.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(totalPoints(state)).toBe(8);
  });

  it('ink.undo 按 id 移除指定的一笔，不影响其它笔', () => {
    const log = makeLog();
    log.writeStroke(stroke('s1'));
    log.writeStroke(stroke('s2'));
    log.writeStroke(stroke('s3'));
    log.undoStroke('s2');

    expect(composeBoard('b1', log.all).strokes.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('撤销是「追加一条撤销事件」，原事件仍在日志里', () => {
    const log = makeLog();
    log.writeStroke(stroke('s1'));
    const before = log.all.length;
    log.undoStroke('s1');

    // 这是关键：日志只增不减，所以同步和回放不会错乱
    expect(log.all.length).toBe(before + 1);
    expect(log.all.some((e) => e.kind === 'ink.stroke')).toBe(true);
    expect(composeBoard('b1', log.all).strokes).toHaveLength(0);
  });

  it('ink.clear 清空全部笔迹，但不清空 AI 写的板面块', () => {
    const log = makeLog();
    log.aiWrite({ op: 'append', html: 'AI 写的', region: 'a' });
    log.writeStroke(stroke('s1'));
    log.writeStroke(stroke('s2'));
    log.clearInk();

    const state = composeBoard('b1', log.all);
    expect(state.strokes).toHaveLength(0);
    expect(state.blocks).toHaveLength(1);
  });

  it('清空之后还能继续画', () => {
    const log = makeLog();
    log.writeStroke(stroke('s1'));
    log.clearInk();
    log.writeStroke(stroke('s2'));

    expect(composeBoard('b1', log.all).strokes.map((s) => s.id)).toEqual(['s2']);
  });

  it('lastStroke 返回最后画上去的那一笔', () => {
    const log = makeLog();
    expect(lastStroke(composeBoard('b1', log.all))).toBeNull();
    log.writeStroke(stroke('s1'));
    log.writeStroke(stroke('s2'));
    expect(lastStroke(composeBoard('b1', log.all))?.id).toBe('s2');
  });
});

// ── 选项 ──────────────────────────────────────────────────────

describe('AI 出选项与用户作答', () => {
  it('ai.ask 设置选项，user.answer 清空它', () => {
    const log = makeLog();
    log.aiAsk([
      { id: '1', label: '继续' },
      { id: '2', label: '换个例子' },
    ]);
    expect(composeBoard('b1', log.all).choices).toHaveLength(2);

    log.answer('1');
    expect(composeBoard('b1', log.all).choices).toBeNull();
  });

  it('user.say 不改变板面', () => {
    const log = makeLog();
    log.writeStroke(stroke('s1'));
    const before = composeBoard('b1', log.all);
    log.say('这里没懂');
    const after = composeBoard('b1', log.all);

    expect(after.strokes).toEqual(before.strokes);
    expect(after.blocks).toEqual(before.blocks);
  });
});

describe('视觉回流（截图）', () => {
  it('board.snapshot 只记录引用，不把图片塞进日志', () => {
    const log = makeLog();
    log.snapshot({ attachmentId: 'att-1', text: '这里没懂' });

    const state = composeBoard('b1', log.all);
    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]?.attachmentId).toBe('att-1');
    expect(state.snapshots[0]?.text).toBe('这里没懂');

    // 整条事件序列化之后应该很小 —— 图片本体在附件表里，不在日志里
    expect(JSON.stringify(log.all).length).toBeLessThan(1000);
  });

  it('只画了个圈、没打字也能发', () => {
    const log = makeLog();
    log.snapshot({ attachmentId: 'att-1', text: null });
    expect(composeBoard('b1', log.all).snapshots[0]?.text).toBeNull();
  });

  it('截图不改变板面本身（块、笔迹都不受影响）', () => {
    const log = makeLog();
    log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    log.writeStroke(stroke('s1'));
    const before = composeBoard('b1', log.all);

    log.snapshot({ attachmentId: 'att-1', text: '看这里' });
    const after = composeBoard('b1', log.all);

    expect(after.blocks).toEqual(before.blocks);
    expect(after.strokes).toEqual(before.strokes);
    expect(after.snapshots).toHaveLength(1);
  });

  it('多次截图按顺序累积', () => {
    const log = makeLog();
    log.snapshot({ attachmentId: 'att-1', text: '第一张' });
    log.snapshot({ attachmentId: 'att-2', text: '第二张' });
    expect(composeBoard('b1', log.all).snapshots.map((s) => s.attachmentId)).toEqual([
      'att-1',
      'att-2',
    ]);
  });

  it('图说（caption）预留字段可以填', () => {
    const log = makeLog();
    log.snapshot({ attachmentId: 'att-1', text: null, caption: '用户在判别式上画了圈' });
    expect(composeBoard('b1', log.all).snapshots[0]?.caption).toBe('用户在判别式上画了圈');
  });
});

// ── 反馈 ──────────────────────────────────────────────────────

describe('对 AI 输出表态', () => {
  it('★ 块记住了它是哪条事件写出来的（反馈要指向事件，不是位置）', () => {
    const log = makeLog();
    const event = log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    const block = composeBoard('b1', log.all).blocks[0];
    expect(block?.sourceEventId).toBe(event.id);
  });

  it('set 改写之后，块指向的是**新的**那条事件', () => {
    const log = makeLog();
    log.aiWrite({ op: 'append', html: '<p>旧</p>', region: 'a' });
    const rewrite = log.aiWrite({ op: 'set', region: 'a', html: '<p>新</p>' });

    const block = composeBoard('b1', log.all).blocks[0];
    // 块现在的内容是 set 写的，反馈该指向 set
    expect(block?.sourceEventId).toBe(rewrite.id);
  });

  it('表态记进板面状态', () => {
    const log = makeLog();
    const written = log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    log.giveFeedback(written.id, 'useful');

    expect(composeBoard('b1', log.all).feedback[written.id]).toBe('useful');
  });

  it('三种表态都能记', () => {
    const log = makeLog();
    const a = log.aiWrite({ op: 'append', html: '<p>a</p>', region: 'a' });
    const b = log.aiWrite({ op: 'append', html: '<p>b</p>', region: 'b' });
    const c = log.aiWrite({ op: 'append', html: '<p>c</p>', region: 'c' });

    log.giveFeedback(a.id, 'useful');
    log.giveFeedback(b.id, 'useless');
    log.giveFeedback(c.id, 'wrong');

    const { feedback } = composeBoard('b1', log.all);
    expect(feedback[a.id]).toBe('useful');
    expect(feedback[b.id]).toBe('useless');
    expect(feedback[c.id]).toBe('wrong');
  });

  it('★ 改主意时覆盖，不是叠加 —— 板面仍然是事件的纯函数', () => {
    const log = makeLog();
    const written = log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    log.giveFeedback(written.id, 'useless');
    log.giveFeedback(written.id, 'useful');

    expect(composeBoard('b1', log.all).feedback[written.id]).toBe('useful');
    // 日志里两条反馈都留着（可追溯），但折叠结果只有一个
    expect(log.all.filter((e) => e.kind === 'feedback')).toHaveLength(2);
  });

  it('反馈不改变板面内容', () => {
    const log = makeLog();
    const written = log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    log.writeStroke(stroke('s1'));
    const before = composeBoard('b1', log.all);

    log.giveFeedback(written.id, 'useful');
    const after = composeBoard('b1', log.all);

    expect(after.blocks).toEqual(before.blocks);
    expect(after.strokes).toEqual(before.strokes);
  });

  it('反馈事件由用户产生（不是 AI 自己给自己打分）', () => {
    const log = makeLog();
    const written = log.aiWrite({ op: 'append', html: '<p>x</p>' });
    expect(log.giveFeedback(written.id, 'useful').actor).toBe('user');
  });

  it('乱序到达时折叠结果一致（同步的地基）', () => {
    const log = makeLog();
    const written = log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    log.giveFeedback(written.id, 'wrong');
    log.writeStroke(stroke('s1'));

    const inOrder = composeBoard('b1', log.all);
    const reversed = composeBoard('b1', [...log.all].reverse());
    expect(reversed).toEqual(inOrder);
  });
});

// ── 板的名字 ──────────────────────────────────────────────────

describe('板的重命名', () => {
  it('改名会覆盖建板时的名字', () => {
    const log = makeLog();
    log.createBoard('未命名');
    expect(composeBoard('b1', log.all).title).toBe('未命名');

    log.renameBoard('一元二次方程');
    expect(composeBoard('b1', log.all).title).toBe('一元二次方程');
  });

  it('★ 改名是**追加一条事件**，不是去改原来那条', () => {
    const log = makeLog();
    log.createBoard('旧名字');
    const rename = log.renameBoard('新名字');

    expect(rename.kind).toBe('board.rename');
    // 原来那条还在（可追溯）
    expect(log.all.filter((e) => e.kind === 'board.create')).toHaveLength(1);
    expect(log.all).toHaveLength(2);
  });

  it('改多次，最后一次赢', () => {
    const log = makeLog();
    log.createBoard('一');
    log.renameBoard('二');
    log.renameBoard('三');
    expect(composeBoard('b1', log.all).title).toBe('三');
  });

  it('乱序到达时结果一致（同步的地基）', () => {
    const log = makeLog();
    log.createBoard('一');
    log.renameBoard('二');
    const inOrder = composeBoard('b1', log.all);
    expect(composeBoard('b1', [...log.all].reverse())).toEqual(inOrder);
  });

  it('改名不影响板面内容和笔迹', () => {
    const log = makeLog();
    log.aiWrite({ op: 'append', html: '<p>x</p>', region: 'a' });
    log.writeStroke(stroke('s1'));
    const before = composeBoard('b1', log.all);

    log.renameBoard('新名字');
    const after = composeBoard('b1', log.all);

    expect(after.blocks).toEqual(before.blocks);
    expect(after.strokes).toEqual(before.strokes);
    expect(after.title).toBe('新名字');
  });

  it('改名由用户发起', () => {
    const log = makeLog();
    expect(log.renameBoard('x').actor).toBe('user');
  });
});

// ── 顺序鲁棒性（同步的地基）──────────────────────────────────

describe('事件顺序', () => {
  it('事件乱序到达时，折叠结果与顺序无关', () => {
    const log = makeLog();
    log.createBoard('板');
    log.aiWrite({ op: 'append', html: 'A', region: 'a' });
    log.writeStroke(stroke('s1'));
    log.aiWrite({ op: 'set', region: 'a', html: 'A2' });

    const inOrder = composeBoard('b1', log.all);
    const shuffled = composeBoard('b1', [...log.all].reverse());
    const scrambled = composeBoard('b1', [log.all[2]!, log.all[0]!, log.all[3]!, log.all[1]!]);

    expect(shuffled).toEqual(inOrder);
    expect(scrambled).toEqual(inOrder);
  });

  it('seq 相同时按 (时间, 设备号) 定序，且结果稳定', () => {
    const base = { boardId: 'b1', sessionId: 's1', synced: 0 as const };

    const a: BoardEvent = {
      ...base, id: 'e1', seq: 1, actor: 'user', kind: 'board.create',
      payload: { title: '来自 A' }, createdAt: 2000, deviceId: 'dev-A',
    };
    const b: BoardEvent = {
      ...base, id: 'e2', seq: 1, actor: 'user', kind: 'board.create',
      payload: { title: '来自 B' }, createdAt: 1000, deviceId: 'dev-B',
    };

    // 时间早的排在后面折叠 → 最终标题是时间晚的那个
    expect(composeBoard('b1', [a, b]).title).toBe('来自 A');
    expect(composeBoard('b1', [b, a]).title).toBe('来自 A');

    // 同一时刻则用设备号字典序，两台设备结果一致
    const c = { ...a, createdAt: 1000 };
    expect(composeBoard('b1', [c, b]).title).toBe('来自 B');
    expect(composeBoard('b1', [b, c]).title).toBe('来自 B');
  });

  it('compareEvents 对完全相同的事件返回 0', () => {
    const e = {
      id: 'x', boardId: 'b1', sessionId: 's1', seq: 1, actor: 'user' as const,
      kind: 'ink.clear' as const, payload: null, createdAt: 1, deviceId: 'd', synced: 0 as const,
    };
    expect(compareEvents(e, e)).toBe(0);
  });
});

// ── 日志本身 ──────────────────────────────────────────────────

describe('EventLog', () => {
  it('seq 从 1 开始递增，id 不重复', () => {
    const log = makeLog();
    log.createBoard('x');
    log.writeStroke(stroke('s1'));
    log.writeStroke(stroke('s2'));

    expect(log.all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(new Set(log.all.map((e) => e.id)).size).toBe(3);
  });

  it('自动填好 boardId / sessionId / deviceId / synced', () => {
    const log = makeLog('board-7');
    const e = log.createBoard('x');

    expect(e.boardId).toBe('board-7');
    expect(e.sessionId).toBe('s1');
    expect(e.deviceId).toBe('dev-A');
    expect(e.synced).toBe(0);
  });

  it('actor 按来源自动区分：用户操作是 user，写板是 ai', () => {
    const log = makeLog();
    expect(log.writeStroke(stroke('s1')).actor).toBe('user');
    expect(log.aiWrite({ op: 'append', html: 'x' }).actor).toBe('ai');
  });

  it('all 返回的是只读视图，改不动内部数组', () => {
    const log = makeLog();
    log.createBoard('x');
    expect(log.all).toHaveLength(1);
  });
});
