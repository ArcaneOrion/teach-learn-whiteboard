/**
 * 核心数据类型
 *
 * `core/` 目录的纪律（见技术文档 §2）：
 *   · 不出现任何界面代码（不碰 DOM）
 *   · 不出现任何 SQL
 *   · 只做纯逻辑，输入输出都是普通对象
 *
 * 所以它可以被单元测试直接覆盖，将来换界面、加同步也不会牵连一片。
 */

import type { Stroke } from '../ink/strokes';

/** 谁产生的这个事件 */
export type Actor = 'user' | 'ai' | 'system';

/** 事件类型 —— 这是「唯一真相」的词汇表 */
export type EventKind =
  // 板的生命周期
  | 'board.create'
  // AI 写板面
  | 'ai.write'
  | 'ai.ask'
  // 用户动作
  | 'user.answer'
  | 'user.say'
  // 笔迹
  | 'ink.stroke'
  | 'ink.undo'
  | 'ink.clear'
  // 🔲 预留：记忆（v1 不产生，但解析器认识它，见技术文档 §10.1）
  | 'memory.set';

/** 所有事件共有的「信封」 */
export interface EventEnvelope {
  /** 全局唯一 */
  id: string;
  /** 属于哪块板 */
  boardId: string;
  /** 属于哪次会话（技术文档 §8：板 = 主题，会话 = 一次坐下学习） */
  sessionId: string;
  /** 板内递增序号，决定折叠顺序 */
  seq: number;
  actor: Actor;
  /** UTC 毫秒时间戳 */
  createdAt: number;
  /** 哪台设备产生的（同步时用来定序、去重） */
  deviceId: string;
  /** 0 = 还没同步到远端 */
  synced: 0 | 1;
}

/** AI 出的选项 */
export interface Choice {
  id: string;
  label: string;
}

/**
 * AI 允许对板面做的操作（技术文档 §4）。
 *
 * 注意这里**没有**「重发整块 HTML」这个选项 —— 那是刻意的：
 * 整块重发会冲掉用户笔迹、把滚动顶回顶部、还白烧 token。
 */
export type BoardOp =
  | { op: 'append'; html: string; region?: string }
  | { op: 'set'; region: string; html: string }
  | { op: 'remove'; region: string };

/**
 * 事件 = 信封 + 类型 + 载荷。
 *
 * 用「可辨识联合」而不是 `payload: unknown`：折叠时 TypeScript 能按 `kind`
 * 自动收窄类型，字段名写错编译器立刻报错。
 */
export type BoardEvent = EventEnvelope &
  (
    | { kind: 'board.create'; payload: { title: string } }
    | { kind: 'ai.write'; payload: BoardOp }
    | { kind: 'ai.ask'; payload: { choices: Choice[] } }
    | { kind: 'user.answer'; payload: { choiceId: string } }
    | { kind: 'user.say'; payload: { text: string } }
    | { kind: 'ink.stroke'; payload: { stroke: Stroke } }
    | { kind: 'ink.undo'; payload: { strokeId: string } }
    | { kind: 'ink.clear'; payload: null }
    | { kind: 'memory.set'; payload: unknown }
  );

/** 取某个事件类型的载荷类型，例如 `EventPayload<'ink.stroke'>` = `{ stroke: Stroke }` */
export type EventPayload<K extends EventKind> = Extract<BoardEvent, { kind: K }>['payload'];

/** 取某个事件类型的完整类型，例如 `EventOf<'ink.stroke'>` */
export type EventOf<K extends EventKind> = Extract<BoardEvent, { kind: K }>;
