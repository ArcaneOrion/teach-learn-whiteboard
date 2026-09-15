/**
 * 「记录」面板 —— 找得回来（产品文档第 8、9 节）
 *
 * 两个功能合成一个面板：
 *   · 上面是**搜索**：搜板面内容、你说的话、截图的图说
 *   · 下面是**按日期的学习记录**：今天 / 昨天 / 更早，每次会话学了多久
 *
 * 为什么合成一个：用户脑子里只有一个问题 ——「那个东西在哪」。
 * 是搜出来还是翻日期翻出来的，他自己一开始也未必知道。
 */

import type { SearchDoc, SearchHit } from '../core/search';
import type { SessionRecord } from '../core/session';
import type { Store } from '../store/types';

import { groupSessionsByDay, humanDuration, sessionTitle } from '../core/history';
import { search } from '../core/search';
import { snippetAround } from './htmlText';

export interface HistoryPanelCallbacks {
  /** 面板打开时重新取一遍数据 */
  refresh: () => Promise<{
    index: readonly SearchDoc[];
    sessions: readonly SessionRecord[];
    /** 会话 id → 「这次学了什么」（用户自己说的第一句话） */
    sessionHints: ReadonlyMap<string, string>;
  }>;
  /** 点了某条搜索结果：切到它所在的板，并把板面滚到对应的块上去 */
  locate: (doc: SearchDoc) => void | Promise<void>;
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (el === null) throw new Error(`记录面板里找不到元素：${selector}`);
  return el;
}

const KIND_LABEL: Record<SearchDoc['kind'], string> = {
  board: '板的标题',
  'ai.write': '板面',
  'user.say': '你说的',
  snapshot: '截图',
};

export class HistoryPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly results: HTMLElement;
  private readonly history: HTMLElement;

  private index: readonly SearchDoc[] = [];
  private sessions: readonly SessionRecord[] = [];
  /** 会话 id → 「这次学了什么」 */
  private hints: ReadonlyMap<string, string> = new Map();
  /** 已加载过的截图缩略图缓存，避免每次搜索都去读一遍数据库 */
  private readonly thumbs = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly callbacks: HistoryPanelCallbacks,
  ) {
    this.dialog = must<HTMLDialogElement>(document, '#history');
    this.input = must<HTMLInputElement>(this.dialog, '#history-search');
    this.results = must<HTMLElement>(this.dialog, '#history-results');
    this.history = must<HTMLElement>(this.dialog, '#history-days');

    must<HTMLButtonElement>(this.dialog, '#close-history').addEventListener('click', () => {
      this.dialog.close();
    });

    this.input.addEventListener('input', () => {
      this.render();
    });
  }

  async open(): Promise<void> {
    const data = await this.callbacks.refresh();
    this.index = data.index;
    this.sessions = data.sessions;
    this.hints = data.sessionHints;
    this.input.value = '';
    this.render();
    this.dialog.showModal();
    this.input.focus();
  }

  /** 面板是不是正开着（开着的时候新事件进来要刷新一遍，否则搜不到刚写的东西） */
  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** 事件变了（面板开着的时候又写了内容）→ 重新拉一遍数据 */
  async reload(): Promise<void> {
    const data = await this.callbacks.refresh();
    this.index = data.index;
    this.sessions = data.sessions;
    this.hints = data.sessionHints;
    if (this.dialog.open) this.render();
  }

  private render(): void {
    const query = this.input.value.trim();
    if (query === '') {
      this.results.replaceChildren();
      this.results.hidden = true;
      this.history.hidden = false;
      this.renderHistory();
    } else {
      this.history.hidden = true;
      this.results.hidden = false;
      this.renderResults(query);
    }
  }

  // ── 搜索结果 ────────────────────────────────────────────────

  private renderResults(query: string): void {
    // 动态导入 core/search 的 search()（避免顶层再引一次）
    const hits = search(this.index, query);
    this.results.replaceChildren();

    if (hits.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = `没找到「${query}」。试试更短的关键词。`;
      this.results.append(empty);
      return;
    }

    const header = document.createElement('div');
    header.className = 'history__count';
    header.textContent = `找到 ${hits.length} 条`;
    this.results.append(header);

    for (const hit of hits) this.results.append(this.resultNode(hit, query));
  }

  private resultNode(hit: SearchHit, query: string): HTMLElement {
    const row = document.createElement('button');
    row.className = 'hit';
    row.type = 'button';

    const head = document.createElement('div');
    head.className = 'hit__head';

    const kind = document.createElement('span');
    kind.className = 'hit__kind';
    kind.textContent = KIND_LABEL[hit.kind];

    const title = document.createElement('span');
    title.className = 'hit__title';
    title.textContent = hit.title;

    /**
     * 检索是**跨全部板**的，所以每条结果都得说清它来自哪块板 ——
     * 否则一列结果全是"不知道在哪"，点进去还会莫名其妙跳到别的板。
     */
    const board = document.createElement('span');
    board.className = 'hit__board';
    board.textContent = hit.boardTitle;

    const when = document.createElement('span');
    when.className = 'hit__when';
    when.textContent = new Date(hit.createdAt).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    head.append(kind, board, title, when);

    const body = document.createElement('div');
    body.className = 'hit__body';
    // 摘要高亮命中词：把命中的那一段截出来，用户才知道为什么这条被搜出来
    body.textContent = snippetAround(hit.body, query) || '（这一条没有文字）';

    row.append(head, body);

    // 截图：把缩略图也显示出来，一眼就知道是哪张
    if (hit.attachmentId !== null) {
      const thumb = document.createElement('img');
      thumb.className = 'hit__thumb';
      thumb.alt = '截图';
      const cached = this.thumbs.get(hit.attachmentId);
      if (cached !== undefined) {
        thumb.src = cached;
      } else {
        void this.loadThumb(hit.attachmentId, thumb);
      }
      row.append(thumb);
    }

    row.addEventListener('click', () => {
      this.callbacks.locate(hit);
      // 定位到板面上的块，所以把面板收起来，让用户看到板
      if (hit.kind === 'ai.write') this.dialog.close();
    });

    return row;
  }

  private async loadThumb(attachmentId: string, img: HTMLImageElement): Promise<void> {
    try {
      const found = await this.store.getAttachment(attachmentId);
      if (found === null) return;
      const url = URL.createObjectURL(found.blob);
      this.thumbs.set(attachmentId, url);
      img.src = url;
    } catch {
      // 缩略图加载失败不影响搜索本身
    }
  }

  // ── 按日期的学习记录 ────────────────────────────────────────

  private renderHistory(): void {
    this.history.replaceChildren();

    if (this.sessions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有学习记录。';
      this.history.append(empty);
      return;
    }

    const groups = groupSessionsByDay(this.sessions, Date.now());

    for (const group of groups) {
      const heading = document.createElement('div');
      heading.className = 'day';
      heading.textContent = `${group.label} · 学了 ${humanDuration(group.totalMs)}`;
      this.history.append(heading);

      for (const s of group.sessions) {
        const row = document.createElement('div');
        row.className = 'session';

        const name = document.createElement('div');
        name.className = 'session__name';
        /**
         * 标题优先用「用户自己说的第一句话」。
         *
         * 原来是「15:58 开始的学习 · 已 12 分钟」—— 攒了三十次之后，
         * 三十行一模一样的「xx:xx 开始的学习」等于没有标题，
         * 而用户打开记录面板想找的恰恰是"上次那个讲判别式的"。
         */
        name.textContent = this.hints.get(s.id) ?? sessionTitle(s);

        const meta = document.createElement('div');
        meta.className = 'session__meta';
        const duration = humanDuration(Math.max(0, (s.endedAt ?? s.lastActive) - s.startedAt));
        meta.textContent = s.endedAt === null ? `进行中 · 已 ${duration}` : duration;

        row.append(name, meta);
        this.history.append(row);
      }
    }
  }

  /** 存储占用（截图是大头，用户得能看见它涨到哪了） */
  async storageSummary(): Promise<string> {
    const bytes = await this.store.attachmentBytes();
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}
