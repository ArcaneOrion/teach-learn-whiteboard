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
 * 把系统提示词**折成一条普通的 user 消息**，插在最前面。
 *
 * ## 为什么不发 `system` 角色
 *
 * pi-ai 对 OpenAI 兼容端点的处理是写死的：`context.systemPrompt` 有值就发
 * `{ role: "system", content: … }`（`api/openai-completions.js` 第 909 行），
 * 没有开关可关。
 *
 * 但不少 OpenAI 兼容端点对 `system` 兼容得不好 —— 实测 ModelScope 会直接报错。
 * 而「指令放在 user 消息里」是所有端点都认的老格式（ChatML 时代就是这么干的）。
 *
 * ## 为什么返回 `inserted`
 *
 * 调用方（main.ts）拿折叠后的数组去请求模型，请求完要把**模型新说的话**归档回
 * 持久历史。它得知道开头有几条是我们临时插进去的，才能精确地跳过它们 ——
 * 否则每轮都会把提示词存进历史，越积越多。
 *
 * ## 折出来的是拷贝，不改原数组
 *
 * 持久历史里**永远不存**提示词。这样每一轮都从干净的数据重新折，
 * 不会出现「上一轮折过、这一轮又折一遍」的叠加。
 */
export function foldSystemIntoUser(
  messages: readonly Message[],
  system: string,
): { messages: Message[]; inserted: number } {
  const text = system.trim();
  if (text === '') return { messages: [...messages], inserted: 0 };

  const first = messages[0];
  // 裁剪过的历史一定以 user 开头，但别赌 —— 万一不是，就另插一条
  if (first !== undefined && first.role === 'user') {
    return { messages: [prependText(first, text), ...messages.slice(1)], inserted: 0 };
  }
  return { messages: [userMessage(text), ...messages], inserted: 1 };
}

/** 用户的文字开头接上一段，返回**新对象**（不动原来的） */
function prependText(msg: Message & { role: 'user' }, prefix: string): Message {
  if (typeof msg.content === 'string') {
    return { ...msg, content: `${prefix}\n\n${msg.content}` };
  }
  const blocks = [...msg.content];
  const at = blocks.findIndex((b) => b.type === 'text');
  if (at >= 0) {
    const block = blocks[at] as { type: 'text'; text: string };
    blocks[at] = { ...block, text: `${prefix}\n\n${block.text}` };
  } else {
    blocks.unshift({ type: 'text', text: prefix });
  }
  return { ...msg, content: blocks };
}

function userMessage(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

/**
 * 装配一次调用的上下文。
 *
 * `memories` 参数现在就留着，虽然 v1 永远传空 —— 这样将来加记忆系统时
 * 不用去改每一个调用点（这就是「预留接口」的意义）。
 */
export function assembleContext(opts: AssembleOptions): Context {
  void opts.memories; // 🔲 预留，v1 不用

  const folded = foldSystemIntoUser(trimMessages(opts.messages, opts.keepExchanges), opts.systemPrompt);

  const context: Context = {
    messages: folded.messages,
  };
  return context;
}
