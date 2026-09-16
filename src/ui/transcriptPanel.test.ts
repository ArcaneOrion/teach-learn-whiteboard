/** @vitest-environment jsdom */

/**
 * AI 对话面板的测试
 *
 * 这个面板是**唯一**一处把模型生成的字符串直接显示给用户、又没有过 DOMPurify 的地方
 * （板面那条路有净化，这里走的是纯文本）。所以「有没有被当成 HTML 解析」
 * 是这里最要紧的一条 —— 一旦漏了，模型吐一句 `<img onerror=...>`
 * 就能在这个 App 里执行任意代码，而本机最值钱的东西是用户的 API Key。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { TranscriptPanel, type TranscriptTurn } from './transcriptPanel';

function makeTurn(over: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    at: new Date(2026, 8, 16, 10, 6).getTime(),
    question: '',
    answer: '',
    thinking: '',
    tools: [],
    ...over,
  };
}

/**
 * jsdom 没实现 `<dialog>` 的 showModal / close（只实现了元素的 `open` 属性）。
 *
 * ⚠️ 这是**测试环境的缺口，不是代码的问题** —— 所以补在这里，
 * 不去改生产代码迁就测试。（真浏览器里这两个方法是标准的。）
 */
if (typeof HTMLDialogElement !== 'undefined') {
  if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== 'function') {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
  }
}

interface Harness {
  panel: TranscriptPanel;
  listBox: HTMLElement;
  setTurns: (turns: TranscriptTurn[]) => void;
}

function setup(): Harness {
  document.body.innerHTML = `
    <dialog id="transcript">
      <button id="close-transcript" type="button">关闭</button>
      <div id="transcript-list"></div>
    </dialog>
  `;

  const listBox = document.querySelector<HTMLElement>('#transcript-list');
  if (listBox === null) throw new Error('测试用的 DOM 没搭起来');

  let turns: TranscriptTurn[] = [];
  const panel = new TranscriptPanel(() => turns);

  return {
    panel,
    listBox,
    setTurns: (next) => {
      turns = next;
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('AI 对话面板', () => {
  it('没有内容时说清楚"这里会有什么"，而不是给一片空白', () => {
    const { panel, listBox } = setup();
    panel.open();
    expect(listBox.textContent).toContain('还没有内容');
  });

  it('★ 模型的文字必须当纯文本，绝不能变成 HTML', () => {
    const { panel, listBox, setTurns } = setup();
    setTurns([
      makeTurn({
        answer: '<img src=x onerror="alert(1)">你好',
        thinking: '<script>alert(2)</script>思考',
      }),
    ]);
    panel.open();

    // 一个都没被解析成元素
    expect(listBox.querySelector('img')).toBeNull();
    expect(listBox.querySelector('script')).toBeNull();
    // 但文字还在（是转义后的文本，不是被丢掉）
    expect(listBox.textContent).toContain('<img src=x onerror="alert(1)">你好');
    expect(listBox.textContent).toContain('<script>alert(2)</script>思考');
  });

  it('回答要保留换行（不能被挤成一坨）', () => {
    const { panel, listBox, setTurns } = setup();
    setTurns([makeTurn({ answer: '第一行\n第二行' })]);
    panel.open();

    const answer = listBox.querySelector<HTMLElement>('.turn__answer');
    // 换成行的责任在这一层：文本原样带着 \n 交给 DOM
    expect(answer?.textContent).toBe('第一行\n第二行');
    // 真正把 \n 画成换行的是 CSS 的 white-space: pre-wrap。
    // 这里**不断言 computed style** —— jsdom 不加载 style.css，那样断言是假绿。
    // CSS 那条规则靠截图验证（.artifacts/ui-03-transcript.png）。
    expect(answer?.className).toBe('turn__answer');
  });

  it('工具、时间、问题都显示出来', () => {
    const { panel, listBox, setTurns } = setup();
    setTurns([makeTurn({ question: '讲讲一元二次方程', tools: ['search_materials', 'board_write'] })]);
    panel.open();

    expect(listBox.querySelector('.turn__time')?.textContent).toBe('10:06');
    expect([...listBox.querySelectorAll('.turn__tool')].map((e) => e.textContent)).toEqual([
      'search_materials',
      'board_write',
    ]);
    expect(listBox.querySelector('.turn__question')?.textContent).toBe('讲讲一元二次方程');
  });

  it('思考过程默认折起来（不然又长又绕，会把回答挤没）', () => {
    const { panel, listBox, setTurns } = setup();
    setTurns([makeTurn({ thinking: '一二三四五' })]);
    panel.open();

    const details = listBox.querySelector<HTMLDetailsElement>('details.turn__think');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false); // 原生 details 的默认态就是折叠
    expect(details?.querySelector('summary')?.textContent).toContain('5 字');
  });

  it('★ 只调了工具、一个字没说时，要明说，不能给一张空卡片', () => {
    // 推理模型上很常见：直接 board_write，不吐任何文字。
    // 用户看着空卡片只会以为界面坏了。
    const { panel, listBox, setTurns } = setup();
    setTurns([makeTurn({ tools: ['board_write'] })]);
    panel.open();

    expect(listBox.textContent).toContain('直接写到板上了');
  });

  it('失败要显示出来，而且原始错误也要留着（排查时两边都要看）', () => {
    const { panel, listBox, setTurns } = setup();
    setTurns([makeTurn({ error: '连接失败。\n（原始错误：Failed to fetch）' })]);
    panel.open();

    const err = listBox.querySelector<HTMLElement>('.turn__error');
    expect(err?.textContent).toContain('连接失败');
    expect(err?.textContent).toContain('Failed to fetch');
  });

  it('★ 新的排在最上面（点开就想看刚才那条，不想先滚到底）', () => {
    const { panel, listBox, setTurns } = setup();
    setTurns([
      makeTurn({ at: new Date(2026, 8, 16, 10, 0).getTime(), answer: '早的' }),
      makeTurn({ at: new Date(2026, 8, 16, 10, 5).getTime(), answer: '晚的' }),
    ]);
    panel.open();

    const answers = [...listBox.querySelectorAll('.turn__answer')].map((e) => e.textContent);
    expect(answers).toEqual(['晚的', '早的']);
  });
});
