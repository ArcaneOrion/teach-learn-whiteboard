/**
 * 本地演示渠道（假模型）—— **只在开发模式注册**
 *
 * 存在的意义：让「用户发话 → 模型调用工具 → 内容写到板上」这整条链路
 * **在没有 API Key 的情况下也能跑通、能看见**。
 *
 * 它不是玩具：走的是和真模型**完全相同**的代码路径（同样的工具、同样的回路、
 * 同样的净化与增量渲染）。区别只在"谁来产生那段回复"。
 *
 * ⚠️ 生产构建里不会包含它 —— main.ts 用 import.meta.env.DEV 包着，
 *    Vite 在打包时会整块删掉。
 */

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Provider,
} from '@earendil-works/pi-ai';

import { TOOL_BOARD_WRITE, TOOL_SEARCH_MATERIALS } from './tools';

/** 把用户输入安全地放进 HTML（演示用；真正的防线是 sanitize.ts） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface DemoChannel {
  provider: Provider;
  getModel: () => ReturnType<ReturnType<typeof fauxProvider>['getModel']>;
  /** 每次用户发话前重新装填剧本 */
  arm: (userText: string) => void;
}

let demoSeq = 0;

export function createDemoChannel(): DemoChannel {
  /**
   * 让假模型**按真实速度出字**，而不是一瞬间全部吐完。
   *
   * 两个理由：
   *   ① 真模型是流式的，演示也该是 —— 否则用户对"它工作时是什么样"没有概念
   *   ② 瞬间出完的话，「停止」按钮根本没有机会被按到，那个功能也就没法验
   */
  const faux = fauxProvider({ tokensPerSecond: 80 });

  return {
    provider: faux.provider,
    getModel: () => faux.getModel(),

    arm(userText: string) {
      // region 会显示在界面上（板面块的标识、搜索结果里），所以用可读的名字，别用机器 id
      demoSeq += 1;
      const region = `讲解 ${String(demoSeq)}`;
      const safe = escapeHtml(userText.slice(0, 80));
      const cleaned = userText.replace(/\s+/g, '').slice(0, 30);

      faux.setResponses([
        // 第一圈：先去查用户上传的资料（M7 的检索工具）。
        // 查到什么由**真实实现**决定 —— 这里只是触发它，所以这一圈验的是真链路。
        fauxAssistantMessage(
          [fauxToolCall(TOOL_SEARCH_MATERIALS, { query: cleaned === '' ? '一元二次方程' : cleaned })],
          { stopReason: 'toolUse' },
        ),
        // 第二圈：把讲解写到板上
        fauxAssistantMessage(
          [
            fauxText('好，我写到板上。'),
            fauxToolCall(TOOL_BOARD_WRITE, {
              op: 'append',
              region,
              html: [
                `<h3>关于「${safe}」</h3>`,
                '<p>这一块是<b>模型通过工具调用</b>写到板上的，走的是和真模型完全相同的路径。</p>',
                '<math display="block">',
                '  <mi>x</mi><mo>=</mo>',
                '  <mfrac>',
                '    <mrow><mo>&#x2212;</mo><mi>b</mi><mo>&#x00B1;</mo>',
                '      <msqrt><msup><mi>b</mi><mn>2</mn></msup><mo>&#x2212;</mo><mn>4</mn><mi>a</mi><mi>c</mi></msqrt>',
                '    </mrow>',
                '    <mrow><mn>2</mn><mi>a</mi></mrow>',
                '  </mfrac>',
                '</math>',
                '<p>试试用笔在这条公式上<b>画个圈</b> —— 你的笔迹会盖在它上面，而且不会被下一次更新冲掉。</p>',
              ].join(''),
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        // 第三圈：收尾
        fauxAssistantMessage([fauxText('写好了，你可以在上面圈画。')]),
      ]);
    },
  };
}
