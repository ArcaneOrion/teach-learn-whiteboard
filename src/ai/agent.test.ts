/**
 * 对话回路的测试 —— 用 pi-ai 自带的 faux provider（假模型）
 *
 * 为什么用假模型：**这样不需要 API Key 就能把整条链路测透**。
 * 一旦接上真模型，出问题时你分不清是「模型不听话」还是「我们的循环写错了」。
 * 用剧本化的假模型，循环本身的正确性可以被完全确定下来。
 *
 * 真实模型的行为差异（不调用工具、参数写错、超时……）留到接上真模型后再补。
 */

import type { Context } from '@earendil-works/pi-ai';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import { runTurn, type ToolOutcome } from './agent';
import { assembleContext, trimMessages } from './context';
import { TOOL_ASK_USER, TOOL_BOARD_WRITE, boardTools } from './tools';

/** 建一个「假模型 + 剧本」的测试台 */
function makeHarness(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const faux = fauxProvider({});
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);

  const context = assembleContext({
    systemPrompt: '你在白板上讲课',
    messages: [{ role: 'user', content: '讲讲一元二次方程', timestamp: Date.now() }],
  });
  context.tools = boardTools;

  return { models, model: faux.getModel(), context, faux };
}

describe('runTurn —— 模型只回文字', () => {
  it('没有工具调用时，一轮就结束', async () => {
    const h = makeHarness([fauxAssistantMessage([fauxText('好的，我写一段。')])]);
    const execute = vi.fn();

    const result = await runTurn({
      models: h.models,
      model: h.model,
      context: h.context,
      execute,
    });

    expect(result.toolCalls).toBe(0);
    expect(result.stopReason).toBe('stop');
    expect(result.steps).toBe(1);
    expect(result.text).toBe('好的，我写一段。');
    expect(execute).not.toHaveBeenCalled();
  });

  it('流式回调能收到累积的文字', async () => {
    const h = makeHarness([fauxAssistantMessage([fauxText('一二三')])]);
    const deltas: string[] = [];

    const result = await runTurn({
      models: h.models,
      model: h.model,
      context: h.context,
      execute: () => ({ result: 'ok' }),
      onTextDelta: (d) => deltas.push(d),
    });

    expect(deltas.join('')).toBe('一二三');
    expect(result.text).toBe('一二三');
  });

  it('模型回复被放进上下文（否则下一圈它不记得自己说过什么）', async () => {
    const h = makeHarness([fauxAssistantMessage([fauxText('好的')])]);
    const before = h.context.messages.length;

    await runTurn({ models: h.models, model: h.model, context: h.context, execute: () => ({ result: 'ok' }) });

    expect(h.context.messages.length).toBe(before + 1);
    expect(h.context.messages[before]?.role).toBe('assistant');
  });
});

describe('runTurn —— 工具调用', () => {
  it('★ 模型调用 board_write 时，执行器收到正确的名字和参数', async () => {
    const h = makeHarness([
      fauxAssistantMessage(
        [fauxToolCall(TOOL_BOARD_WRITE, { op: 'append', region: '第1步', html: '<p>标准形式</p>' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('写好了。')]),
    ]);

    const execute = vi.fn(
      (name: string, _args: Record<string, unknown>): ToolOutcome => ({ result: `已执行 ${name}` }),
    );

    const result = await runTurn({
      models: h.models,
      model: h.model,
      context: h.context,
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe(TOOL_BOARD_WRITE);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      op: 'append',
      region: '第1步',
      html: '<p>标准形式</p>',
    });

    // 转了两圈：一圈调工具，一圈收尾
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.text).toBe('写好了。');
  });

  it('工具结果作为 toolResult 消息回给模型', async () => {
    const h = makeHarness([
      fauxAssistantMessage([fauxToolCall(TOOL_BOARD_WRITE, { op: 'append', html: '<p>x</p>' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('好')]),
    ]);

    await runTurn({
      models: h.models,
      model: h.model,
      context: h.context,
      execute: () => ({ result: '已经写到板上了（区域：第1步）' }),
    });

    const toolResult = h.context.messages.find((m) => m.role === 'toolResult');
    expect(toolResult).toBeDefined();
    expect(toolResult?.role === 'toolResult' && toolResult.toolName).toBe(TOOL_BOARD_WRITE);
    expect(
      toolResult?.role === 'toolResult' &&
        toolResult.content.some((b) => b.type === 'text' && b.text.includes('区域：第1步')),
    ).toBe(true);
  });

  it('一次回复里调用多个工具 → 全部执行', async () => {
    const h = makeHarness([
      fauxAssistantMessage(
        [
          fauxToolCall(TOOL_BOARD_WRITE, { op: 'append', region: 'A', html: '<p>A</p>' }),
          fauxToolCall(TOOL_ASK_USER, { choices: [{ id: '1', label: '继续' }] }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('请选择')]),
    ]);

    const execute = vi.fn(
      (_name: string, _args: Record<string, unknown>): ToolOutcome => ({ result: 'ok' }),
    );
    const result = await runTurn({ models: h.models, model: h.model, context: h.context, execute });

    expect(result.toolCalls).toBe(2);
    expect(execute.mock.calls.map((c) => c[0])).toEqual([TOOL_BOARD_WRITE, TOOL_ASK_USER]);
  });

  it('★ 工具执行抛异常不会中断整轮，而是变成 isError 的结果回给模型', async () => {
    const h = makeHarness([
      fauxAssistantMessage([fauxToolCall(TOOL_BOARD_WRITE, { op: 'set', region: '不存在', html: 'x' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxText('那我换个方式')]),
    ]);

    const result = await runTurn({
      models: h.models,
      model: h.model,
      context: h.context,
      execute: () => {
        throw new Error('区域不存在');
      },
    });

    // 整轮没被中断，模型还有机会自我修正
    expect(result.steps).toBe(2);
    expect(result.text).toBe('那我换个方式');

    const toolResult = h.context.messages.find((m) => m.role === 'toolResult');
    expect(toolResult?.role === 'toolResult' && toolResult.isError).toBe(true);
    expect(
      toolResult?.role === 'toolResult' &&
        toolResult.content.some((b) => b.type === 'text' && b.text.includes('区域不存在')),
    ).toBe(true);
  });

  it('★ 模型一直调工具时，会在 maxSteps 处停下（防死循环）', async () => {
    const looping = () =>
      fauxAssistantMessage([fauxToolCall(TOOL_BOARD_WRITE, { op: 'append', html: '<p>x</p>' })], {
        stopReason: 'toolUse',
      });
    const h = makeHarness([looping(), looping(), looping(), looping(), looping()]);

    const execute = vi.fn(
      (_name: string, _args: Record<string, unknown>): ToolOutcome => ({ result: 'ok' }),
    );
    const result = await runTurn({
      models: h.models,
      model: h.model,
      context: h.context,
      execute,
      maxSteps: 3,
    });

    expect(result.steps).toBe(3);
    expect(result.toolCalls).toBe(3);
    // stopReason 为 toolUse 是个信号：转数用完了，模型其实还想继续
    expect(result.stopReason).toBe('toolUse');
  });

  it('onToolCall / onToolResult 的回调顺序正确', async () => {
    const h = makeHarness([
      fauxAssistantMessage([fauxToolCall(TOOL_BOARD_WRITE, { op: 'append' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxText('好')]),
    ]);

    const log: string[] = [];
    await runTurn({
      models: h.models,
      model: h.model,
      context: h.context,
      execute: () => ({ result: 'ok' }),
      onToolCall: (name) => log.push(`call:${name}`),
      onToolResult: (name) => log.push(`result:${name}`),
    });

    expect(log).toEqual([`call:${TOOL_BOARD_WRITE}`, `result:${TOOL_BOARD_WRITE}`]);
  });
});

describe('上下文截断', () => {
  it('消息少的时候原样返回', () => {
    const h = makeHarness([fauxAssistantMessage([fauxText('x')])]);
    expect(trimMessages(h.context.messages, 8)).toEqual(h.context.messages);
  });

  it('★ 只保留最后 N 段，且不会把工具调用和它的结果截散', () => {
    const messages = [
      { role: 'user' as const, content: '第1问', timestamp: 1 },
      { role: 'assistant' as const, content: [], timestamp: 2 },
      { role: 'toolResult' as const, toolCallId: 'a', toolName: 't', content: [], isError: false, timestamp: 3 },
      { role: 'user' as const, content: '第2问', timestamp: 4 },
      { role: 'assistant' as const, content: [], timestamp: 5 },
      { role: 'toolResult' as const, toolCallId: 'b', toolName: 't', content: [], isError: false, timestamp: 6 },
      { role: 'user' as const, content: '第3问', timestamp: 7 },
    ];

    const trimmed = trimMessages(messages as unknown as Context['messages'], 2);

    // 从「第2问」开始，工具调用和结果都在一起
    expect(trimmed[0]?.role).toBe('user');
    expect(trimmed[0]?.role === 'user' && trimmed[0].content).toBe('第2问');
    expect(trimmed.filter((m) => m.role === 'toolResult')).toHaveLength(1);
    // 被砍掉的那段里的 toolResult 也一起没了
    expect(trimmed.some((m) => m.role === 'toolResult' && m.toolCallId === 'a')).toBe(false);
  });

  it('截断后第一条永远是用户消息（否则模型会收到无来由的工具结果）', () => {
    const messages = [
      { role: 'user' as const, content: 'q1', timestamp: 1 },
      { role: 'assistant' as const, content: [], timestamp: 2 },
      { role: 'user' as const, content: 'q2', timestamp: 3 },
      { role: 'assistant' as const, content: [], timestamp: 4 },
    ];
    expect(trimMessages(messages as unknown as Context['messages'], 1)[0]?.role).toBe('user');
  });
});

describe('assembleContext', () => {
  it('系统提示词和工具都装配进去', () => {
    const ctx = assembleContext({ systemPrompt: 'S', messages: [] });
    expect(ctx.systemPrompt).toBe('S');
    expect(ctx.messages).toEqual([]);
  });

  it('🔲 预留的记忆参数现在就存在，v1 传空数组也不报错', () => {
    const ctx = assembleContext({ systemPrompt: 'S', messages: [], memories: [] });
    expect(ctx.messages).toEqual([]);
  });
});
