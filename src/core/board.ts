/**
 * 板面折叠（fold）
 *
 * 输入：一串事件。输出：板面现在长什么样。
 *
 * 这是「事件日志是唯一真相」的落地点 —— 板面没有自己的状态，它永远是
 * **事件序列的函数**。所以只要事件序列一样，折叠出来的板面就一定一样，
 * 不管中间经过了多少次增删改、也不管事件是乱序到达的还是同步来的。
 */

import type { BoardEvent, BoardOp, Choice, EventPayload } from './types';
import type { Stroke } from '../ink/strokes';

/** AI 写在板面上的一块内容 */
export interface BoardBlock {
  /**
   * 区域名。`null` = 未命名块，只能追加、不能被定点替换。
   * 对应 HTML 里的 `data-stage-region="区域名"`。
   */
  region: string | null;
  html: string;
}

/** 折叠出来的板面状态 */
export interface BoardState {
  boardId: string;
  title: string;
  /** AI 写的板面内容，按写入顺序 */
  blocks: BoardBlock[];
  /** 用户的笔迹 */
  strokes: Stroke[];
  /** AI 出的选项；用户答完就清空 */
  choices: Choice[] | null;
  /** 拍过的截图（只有引用，图片本体在附件表里） */
  snapshots: EventPayload<'board.snapshot'>[];
}

/**
 * 事件的排序规则。
 *
 * 先按板内序号 `seq`。**序号相同时按 (时间, 设备号) 定序** ——
 * 这个兜底是给同步准备的：两台设备离线时各自递增 seq，一定会撞号，
 * 必须有一个所有设备都能算出一致结果的规则（技术文档 §13）。
 */
export function compareEvents(a: BoardEvent, b: BoardEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.deviceId === b.deviceId) return 0;
  return a.deviceId < b.deviceId ? -1 : 1;
}

/** 把事件序列折叠成板面 */
export function composeBoard(boardId: string, events: readonly BoardEvent[]): BoardState {
  const state: BoardState = {
    boardId,
    title: '',
    blocks: [],
    strokes: [],
    choices: null,
    snapshots: [],
  };

  const ordered = events
    .filter((e) => e.boardId === boardId)
    .slice()
    .sort(compareEvents);

  for (const e of ordered) applyEvent(state, e);

  return state;
}

function applyEvent(state: BoardState, e: BoardEvent): void {
  switch (e.kind) {
    case 'board.create':
      state.title = e.payload.title;
      return;

    case 'ai.write':
      applyWrite(state, e.payload);
      return;

    case 'ai.ask':
      state.choices = e.payload.choices;
      return;

    case 'user.answer':
      state.choices = null;
      return;

    case 'ink.stroke':
      state.strokes.push(e.payload.stroke);
      return;

    case 'ink.undo':
      state.strokes = state.strokes.filter((s) => s.id !== e.payload.strokeId);
      return;

    case 'ink.clear':
      state.strokes = [];
      return;

    case 'board.snapshot':
      // 拍照不改变板面本身，只记录"拍过这么一张"。将来做时间轴回放时会用到
      state.snapshots.push(e.payload);
      return;

    case 'user.say':
      // 说话不改变板面。将来它会影响喂给模型的上文，但不影响画面
      return;

    case 'memory.set':
      // 🔲 预留：v1 不处理（技术文档 §10.1 的钩子①）
      return;

    default: {
      // ⚠️ 这一行不是多余的：将来往 EventKind 里加了新类型却忘了在这里处理，
      // TypeScript 会在编译期报错，而不是运行时静默出错。
      const unhandled: never = e;
      throw new Error(`折叠时遇到未处理的事件类型：${JSON.stringify(unhandled)}`);
    }
  }
}

/** 应用一次 AI 写板操作 */
function applyWrite(state: BoardState, op: BoardOp): void {
  switch (op.op) {
    case 'append':
      state.blocks.push({ region: op.region ?? null, html: op.html });
      return;

    case 'set': {
      const index = state.blocks.findIndex((b) => b.region === op.region);
      if (index === -1) {
        // 要替换的区域不存在 → 退化成追加。
        // 这样 AI 记错区域名时不会丢内容，只是位置不理想
        state.blocks.push({ region: op.region, html: op.html });
      } else {
        state.blocks[index] = { region: op.region, html: op.html };
      }
      return;
    }

    case 'remove':
      state.blocks = state.blocks.filter((b) => b.region !== op.region);
      return;

    default: {
      const unhandled: never = op;
      throw new Error(`未知的写板操作：${JSON.stringify(unhandled)}`);
    }
  }
}

// ── 给界面用的小工具 ──────────────────────────────────────────

/** 当前还能撤销的那一笔（也就是最后画上去的那一笔） */
export function lastStroke(state: BoardState): Stroke | null {
  return state.strokes.length > 0 ? (state.strokes[state.strokes.length - 1] ?? null) : null;
}

/** 笔迹总采样点数（调试读数用） */
export function totalPoints(state: BoardState): number {
  let n = 0;
  for (const s of state.strokes) n += s.points.length;
  return n;
}
