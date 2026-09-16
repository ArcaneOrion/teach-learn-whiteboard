/**
 * 「AI 对话」面板 —— 看模型这一轮**说了什么、想了什么、动了哪些工具**。
 *
 * ## 为什么需要它
 *
 * 这个产品的设计是「板是唯一界面」，模型的主要内容都通过 board_write 写到板上。
 * 但模型还会产生两类**只存在于过程中**的东西：
 *
 *   ① **回答文字**（text_delta）—— 它没说出口、也没写进板面的那些话
 *   ② **思考过程**（thinking_delta）—— 推理模型（DeepSeek-R1 / V4.1-Flash 这类）
 *      会吐 reasoning_content
 *
 * 在加这个面板之前，这两类东西**被直接丢掉了**（`onTextDelta` 根本没接）。
 * 后果是：模型要是理解偏了、或者绕了半天，用户完全看不到线索，
 * 只能看到「它没往板上写东西」—— 无从判断是模型不行还是我们哪里错了。
 *
 * ## 为什么思考过程不写进板面
 *
 * 板面是给**学习**的，会被导出、会被复习、会进截图；思考过程是给**排查**的。
 * 混在一起会把板面搞脏，而且推理模型的思考常常又长又绕。
 *
 * ## 安全：模型输出的文字一律用 textContent
 *
 * 这里显示的是**模型生成的字符串**。绝对不能用 innerHTML ——
 * 那等于让模型往这个页面里注入 HTML。板面那条路有 DOMPurify，
 * 这里更简单：纯文本，不需要 HTML。
 */

export interface TranscriptTurn {
  /** 这一轮的开始时间 */
  at: number;
  /** 用户问的话（给回答一点上下文，不然过一会儿就不知道在说啥了） */
  question: string;
  /** 模型说的文字（不写进板面的那些） */
  answer: string;
  /** 模型的思考过程 */
  thinking: string;
  /** 这一轮调用了哪些工具，按顺序 */
  tools: string[];
  /** 这一轮失败了就记在这里 */
  error?: string;
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (el === null) throw new Error(`AI 对话面板里找不到元素：${selector}`);
  return el;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 流式更新时的节流间隔 —— 每个 token 都重排一次会把面板拖卡 */
const REFRESH_INTERVAL_MS = 250;

export class TranscriptPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly listBox: HTMLElement;
  private lastPaint = 0;
  private paintTimer: number | null = null;

  constructor(private readonly source: () => readonly TranscriptTurn[]) {
    this.dialog = must<HTMLDialogElement>(document, '#transcript');
    this.listBox = must<HTMLElement>(this.dialog, '#transcript-list');

    must<HTMLButtonElement>(this.dialog, '#close-transcript').addEventListener('click', () => {
      this.dialog.close();
    });
  }

  open(): void {
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** 有没有内容（状态条上的按钮据此决定要不要提示"有新东西"） */
  hasContent(): boolean {
    return this.source().length > 0;
  }

  /**
   * 来了新内容。
   *
   * 面板**没开着就什么都不做** —— 别为了一个看不见的面板做重排。
   * 开着的时候按 REFRESH_INTERVAL_MS 节流：流式输出一秒能来几十个 delta，
   * 每个都重排一次会把界面拖卡（这是实测过的教训：HUD 早期就是这么写的）。
   */
  notify(): void {
    if (!this.dialog.open) return;

    const now = Date.now();
    const since = now - this.lastPaint;
    if (since >= REFRESH_INTERVAL_MS) {
      this.render();
      return;
    }
    // 攒到间隔结束再画一次，保证最后一段内容不会漏掉
    if (this.paintTimer === null) {
      this.paintTimer = window.setTimeout(() => {
        this.paintTimer = null;
        if (this.dialog.open) this.render();
      }, REFRESH_INTERVAL_MS - since);
    }
  }

  private render(): void {
    this.lastPaint = Date.now();

    const turns = this.source();
    this.listBox.replaceChildren();

    if (turns.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'settings__foot';
      empty.textContent =
        '还没有内容。发一条消息之后，模型的回答和思考会出现在这里 —— 写进板面的内容不在这里，那在板上。';
      this.listBox.append(empty);
      return;
    }

    // 新的在最上面：点开就想看刚才那条，不想先滚到底
    for (const turn of [...turns].reverse()) {
      this.listBox.append(this.renderTurn(turn));
    }
  }

  private renderTurn(turn: TranscriptTurn): HTMLElement {
    const card = document.createElement('article');
    card.className = 'turn';

    const head = document.createElement('div');
    head.className = 'turn__head';

    const time = document.createElement('span');
    time.className = 'turn__time';
    time.textContent = clock(turn.at);
    head.append(time);

    for (const tool of turn.tools) {
      const chip = document.createElement('span');
      chip.className = 'turn__tool';
      chip.textContent = tool;
      head.append(chip);
    }
    card.append(head);

    if (turn.question !== '') {
      const q = document.createElement('p');
      q.className = 'turn__question';
      q.textContent = turn.question;
      card.append(q);
    }

    if (turn.answer !== '') {
      const a = document.createElement('p');
      a.className = 'turn__answer';
      a.textContent = turn.answer;
      card.append(a);
    }

    if (turn.thinking !== '') {
      // 用原生 <details>：折叠一个 div 不需要写一行 JS
      const details = document.createElement('details');
      details.className = 'turn__think';

      const summary = document.createElement('summary');
      summary.textContent = `思考过程（${turn.thinking.length} 字）`;
      details.append(summary);

      const body = document.createElement('p');
      body.textContent = turn.thinking;
      details.append(body);

      card.append(details);
    }

    if (turn.question === '' && turn.answer === '' && turn.thinking === '' && turn.error === undefined) {
      // 只调了工具、什么都没说 —— 这在推理模型上很常见，得说清楚，
      // 否则用户看着一个空卡片会以为界面坏了
      const only = document.createElement('p');
      only.className = 'turn__quiet';
      only.textContent = '（这一轮没有文字，直接写到板上了）';
      card.append(only);
    }

    if (turn.error !== undefined) {
      const err = document.createElement('p');
      err.className = 'turn__error';
      err.textContent = turn.error;
      card.append(err);
    }

    return card;
  }
}
