/**
 * 上下文装配
 *
 * 每次调用模型之前，要把三样东西拼成 Context（技术文档 §6.2）：
 *
 *   ① 系统提示词      —— 告诉模型「你在白板上讲课」
 *   ② 最近的消息      —— **滚动的，不是全部**（否则板越长越贵、越慢，最后爆窗口）
 *   ③ 相关记忆        —— 🔲 预留，v1 永远传空
 *
 * ② 的截断必须小心：**不能把工具结果和它对应的工具调用截散**，
 * 否则模型会收到一个「不知道是谁的结果」的消息，轻则困惑、重则被 API 拒绝。
 */

import type { Context } from '@earendil-works/pi-ai';

type Message = Context['messages'][number];

/** 默认保留最近多少「段」（一段 = 一条用户消息及其之后的全部往返） */
export const DEFAULT_KEEP_EXCHANGES = 8;

/**
 * 滚动的上下文截断。
 *
 * 以**用户消息**为边界切段：`[user, assistant, toolResult, assistant]` 算一段。
 * 只保留最后 N 段，这样永远不会把工具调用和它的结果截散。
 */
export function trimMessages(
  messages: readonly Message[],
  keepExchanges: number = DEFAULT_KEEP_EXCHANGES,
): Message[] {
  if (messages.length === 0) return [];

  // 找出每段的起点（role === 'user' 的位置）
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') starts.push(i);
  }

  // 没有用户消息（理论上不会）→ 原样返回，交给上层
  if (starts.length === 0) return [...messages];

  // 保留最后 keepExchanges 段
  const keepFrom = starts[Math.max(0, starts.length - keepExchanges)] ?? 0;
  return messages.slice(keepFrom);
}

export interface AssembleOptions {
  systemPrompt: string;
  messages: readonly Message[];
  /** 🔲 预留：记忆（技术文档 §10.1 的钩子②）。v1 永远传空数组 */
  memories?: readonly unknown[];
  keepExchanges?: number;
}

/**
 * 装配一次调用的上下文。
 *
 * `memories` 参数现在就留着，虽然 v1 永远传空 —— 这样将来加记忆系统时
 * 不用去改每一个调用点（这就是「预留接口」的意义）。
 */
export function assembleContext(opts: AssembleOptions): Context {
  void opts.memories; // 🔲 预留，v1 不用

  const context: Context = {
    systemPrompt: opts.systemPrompt,
    messages: trimMessages(opts.messages, opts.keepExchanges),
  };
  return context;
}
