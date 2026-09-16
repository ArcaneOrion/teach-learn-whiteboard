/**
 * 一次对话回合（agent turn）
 *
 * 循环长这样：
 *
 *   把上下文喂给模型 → 流式收文本和工具调用
 *        ↓
 *   模型调用了 board_write / ask_user 吗？
 *        ├─ 没有 → 这一轮结束
 *        └─ 有   → 执行它们（写进事件日志），把结果回给模型，再转一圈
 *
 * 「执行」这一步是**由调用方注入的**（`execute` 回调）——
 * 这样 agent 层完全不知道事件日志、存储、界面的存在，只认识「工具」。
 * 将来换模型、换渲染、加同步，这一层都不用动。
 */

import type { Api, Context, Model, Models } from '@earendil-works/pi-ai';

import { withCorsSafeHeaders, type FetchLike } from './corsSafeFetch';

/** 一次工具调用的结果 */
export interface ToolOutcome {
  /** 回给模型的文本（模型靠它判断下一步） */
  result: string;
  isError?: boolean;
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolOutcome> | ToolOutcome;

export interface TurnCallbacks {
  /** 模型吐出一段文字（本产品里通常不多 —— 大部分内容走 board_write） */
  onTextDelta?: (delta: string) => void;
  /** 推理模型的思考过程（reasoning）。**不是**给用户看的答案，是排查用的 */
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, outcome: ToolOutcome) => void;
  /** 每转一圈回调一次，便于界面显示「思考中…」 */
  onStep?: (step: number) => void;
}

export interface RunTurnOptions extends TurnCallbacks {
  models: Models;
  model: Model<Api>;
  /** 会被就地追加（模型回复、工具结果都进这里） */
  context: Context;
  execute: ToolExecutor;
  /** 最多转几圈。防模型陷入「调用→结果→再调用」的死循环 */
  maxSteps?: number;
  signal?: AbortSignal;
  /** 换掉底层的 fetch（测试用）。省略时会自动套上 corsSafeFetch */
  fetch?: FetchLike;
}

export interface TurnResult {
  /** 模型说的聊天文字 */
  text: string;
  /** 这一轮总共发生了几次工具调用 */
  toolCalls: number;
  /** 'stop' = 正常结束；'toolUse' = 转数用完了模型还想调工具 */
  stopReason: 'stop' | 'toolUse';
  /** 实际转了几圈 */
  steps: number;
}

const DEFAULT_MAX_STEPS = 6;

/**
 * 从 error 事件里抠出**真正有用**的错误文本。
 *
 * ⚠️ 踩过的坑：一开始直接用了 `event.reason`，结果用户看到的是
 * **「模型调用出错：error」** —— 那是事件的**类型名**，不是错误内容，等于什么都没说。
 * 真正的原因在 `event.error.errorMessage` 里。
 */
function describeStreamError(message: { errorMessage?: string; content?: { type: string; text?: string }[] }): string {
  if (typeof message.errorMessage === 'string' && message.errorMessage.trim() !== '') {
    return message.errorMessage.trim();
  }
  // 退一步：有些情况下错误文本会作为一段正文内容回来
  const text = (message.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join(' ')
    .trim();
  return text !== '' ? text : '模型没有返回具体原因（看控制台里的原始错误）';
}

/**
 * 跑完一轮对话。
 *
 * 注意：**工具执行失败不会中断整轮** —— 它作为一条 isError 的工具结果回给模型，
 * 让模型自己决定怎么办（换个写法、或者告诉用户失败了）。
 * 这比直接抛异常好：模型往往能自愈，而抛异常会让用户看到一句莫名其妙的报错。
 */
export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  /**
   * ★ 所有请求都套一层 fetch：摘掉 OpenAI SDK 自动加的那串 `x-stainless-*`。
   *
   * 不加这一步，ModelScope 这类「白名单式 CORS」的兼容端点会在预检就被浏览器挡掉，
   * 表现成 `TypeError: Failed to fetch` —— 而 curl 试是通的，极难排查。
   * 详见 corsSafeFetch.ts。
   */
  const fetchImpl = opts.fetch ?? withCorsSafeHeaders();

  let text = '';
  let toolCalls = 0;
  let steps = 0;
  let stopReason: TurnResult['stopReason'] = 'stop';

  for (let step = 0; step < maxSteps; step += 1) {
    steps = step + 1;
    opts.onStep?.(steps);

    const stream = opts.models.stream(opts.model, opts.context, {
      signal: opts.signal,
      fetch: fetchImpl,
    });

    for await (const event of stream) {
      switch (event.type) {
        case 'text_delta':
          text += event.delta;
          opts.onTextDelta?.(event.delta);
          break;
        /**
         * 推理模型的思考过程（DeepSeek-R1 / V4.1-Flash 这类会吐 reasoning_content）。
         *
         * 它不是给用户看的答案，但**有用**：模型要是理解偏了、或者绕了半天，
         * 看一眼思考就知道卡在哪。所以接出来放进「AI 对话」面板，不写进板面 ——
         * 板面是给学习的，思考过程是给排查的，两者混在一起会污染板面。
         */
        case 'thinking_delta':
          opts.onThinkingDelta?.(event.delta);
          break;
        case 'error':
          throw new Error(
            opts.signal?.aborted === true || event.reason === 'aborted'
              ? '已取消'
              : `模型调用出错：${describeStreamError(event.error)}`,
          );
        default:
          // toolcall_delta 等暂不处理
          break;
      }
    }

    // 这一圈的完整回复 —— 必须放进上下文，否则下一圈模型不知道自己刚说过什么
    const message = await stream.result();
    opts.context.messages.push(message);

    const calls = message.content.filter((block) => block.type === 'toolCall');
    if (calls.length === 0) {
      stopReason = 'stop';
      break;
    }

    for (const call of calls) {
      toolCalls += 1;
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      opts.onToolCall?.(call.name, args);

      let outcome: ToolOutcome;
      try {
        outcome = await opts.execute(call.name, args);
      } catch (err) {
        outcome = {
          result: `工具执行失败：${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      opts.onToolResult?.(call.name, outcome);

      opts.context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: outcome.result }],
        isError: outcome.isError ?? false,
        timestamp: Date.now(),
      });
    }

    stopReason = 'toolUse';
  }

  return { text, toolCalls, stopReason, steps };
}
