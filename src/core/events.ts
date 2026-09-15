/**
 * 事件日志 —— 唯一真相
 *
 * 本项目最重要的一个设计决定（技术文档 §3）：
 *   **唯一真相是一串「只追加、不修改」的事件。板面长什么样，是把它折叠算出来的。**
 *
 * 打个比方：板面是电影画面，事件日志是胶片。画面可以随时重放，胶片永远不动。
 *
 * 为什么这么做：同步几乎白拿（推拉日志即可，事件不可变所以没有冲突）、
 * 撤销免费、学习记录免费、可回放、可搜索。
 */

import type {
  Actor,
  BoardEvent,
  EventEnvelope,
  EventKind,
  EventOf,
  EventPayload,
} from './types';
import type { Stroke } from '../ink/strokes';
import type { BoardOp, Choice } from './types';

let counter = 0;

/**
 * 生成事件 id。
 * 同一设备内不重复；将来同步时加上 deviceId 前缀即可全局唯一。
 */
function newEventId(createdAt: number): string {
  counter += 1;
  return `${createdAt.toString(36)}-${counter.toString(36)}`;
}

/**
 * 把「信封 + 类型 + 载荷」拼成一个事件。
 *
 * 这里需要一个类型断言：TypeScript 无法自动证明「任意 kind 与对应 payload 的组合」
 * 就是那个具体的联合成员。断言被关在这一个函数里，外面拿到的都是精确类型。
 */
function make<K extends EventKind>(
  envelope: EventEnvelope,
  kind: K,
  payload: EventPayload<K>,
): EventOf<K> {
  return { ...envelope, kind, payload } as EventOf<K>;
}

export interface EventLogOptions {
  boardId: string;
  sessionId: string;
  deviceId: string;
  /** 便于测试注入固定时间；默认用真实时钟 */
  now?: () => number;
}

/**
 * 一块板的事件日志。
 *
 * 调用方只管「发生了什么」，seq / id / 时间戳 / 设备号由日志统一填 ——
 * 这样就不会出现"某处忘了填 seq"这类错误。
 */
export class EventLog {
  private readonly events: BoardEvent[] = [];
  private seq = 0;

  private readonly now: () => number;

  constructor(private readonly options: EventLogOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 全部事件（只读） */
  get all(): readonly BoardEvent[] {
    return this.events;
  }

  private append<K extends EventKind>(actor: Actor, kind: K, payload: EventPayload<K>): EventOf<K> {
    const createdAt = this.now();
    this.seq += 1;
    const envelope: EventEnvelope = {
      id: newEventId(createdAt),
      boardId: this.options.boardId,
      sessionId: this.options.sessionId,
      seq: this.seq,
      actor,
      createdAt,
      deviceId: this.options.deviceId,
      synced: 0,
    };
    const event = make(envelope, kind, payload);
    this.events.push(event);
    return event;
  }

  // ── 板的生命周期 ────────────────────────────────────────────

  createBoard(title: string): EventOf<'board.create'> {
    return this.append('user', 'board.create', { title });
  }

  // ── AI 写板面 ──────────────────────────────────────────────

  aiWrite(op: BoardOp): EventOf<'ai.write'> {
    return this.append('ai', 'ai.write', op);
  }

  aiAsk(choices: Choice[]): EventOf<'ai.ask'> {
    return this.append('ai', 'ai.ask', { choices });
  }

  // ── 用户动作 ────────────────────────────────────────────────

  answer(choiceId: string): EventOf<'user.answer'> {
    return this.append('user', 'user.answer', { choiceId });
  }

  say(text: string): EventOf<'user.say'> {
    return this.append('user', 'user.say', { text });
  }

  // ── 笔迹 ────────────────────────────────────────────────────

  writeStroke(stroke: Stroke): EventOf<'ink.stroke'> {
    return this.append('user', 'ink.stroke', { stroke });
  }

  /**
   * 撤销一笔。
   *
   * ⚠️ 注意这里**不是**把原事件删掉，而是追加一条「撤销」事件。
   * 这样日志仍然是只追加的，同步和回放都不会错乱。
   * （「把数组里的元素删掉」那种做法在单机时看着更简单，一加同步就会出事。）
   */
  undoStroke(strokeId: string): EventOf<'ink.undo'> {
    return this.append('user', 'ink.undo', { strokeId });
  }

  clearInk(): EventOf<'ink.clear'> {
    return this.append('user', 'ink.clear', null);
  }
}
