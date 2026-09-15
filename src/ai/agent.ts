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
 * 跑完一轮对话。
 *
 * 注意：**工具执行失败不会中断整轮** —— 它作为一条 isError 的工具结果回给模型，
 * 让模型自己决定怎么办（换个写法、或者告诉用户失败了）。
 * 这比直接抛异常好：模型往往能自愈，而抛异常会让用户看到一句莫名其妙的报错。
 */
export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  let text = '';
  let toolCalls = 0;
  let steps = 0;
  let stopReason: TurnResult['stopReason'] = 'stop';

  for (let step = 0; step < maxSteps; step += 1) {
    steps = step + 1;
    opts.onStep?.(steps);

    const stream = opts.models.stream(opts.model, opts.context, { signal: opts.signal });

    for await (const event of stream) {
      switch (event.type) {
        case 'text_delta':
          text += event.delta;
          opts.onTextDelta?.(event.delta);
          break;
        case 'error':
          throw new Error(
            opts.signal?.aborted ? '已取消' : `模型调用出错：${event.reason}`,
          );
        default:
          // thinking / toolcall_delta 等暂不处理（M2 先不做思考过程展示）
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
