/**
 * 「板」面板 —— 多块板之间的切换
 *
 * ## 为什么必须有它
 *
 * 这个 App 会不断累积板（每开一个新主题就多一块），但在此之前**没有任何界面
 * 能看到或切换它们** —— 只能靠启动时自动选中"最近用过的那块"。
 * 用了几天之后，前面学过的主题就等于找不回来了。
 *
 * ## 板 ≠ 会话（技术文档 §8）
 *
 * 这里切的是**板**（主题），不是会话（一次坐下来学习）。
 * 所以切板**不会**新建会话 —— 你可以在同一次学习里翻好几块板，
 * 那正是「板与会话正交」的意思。
 *
 * ## 删除要两步
 *
 * 删掉一块板 = 删掉它全部的事件、笔迹、截图。不可撤销。
 * 和「数据」面板一样，第一步只是"上膛"，把后果写清楚再让点第二次。
 */

import type { BoardRecord } from '../store/types';

export interface BoardSummary {
  board: BoardRecord;
  /** 有多少条「实质内容」事件（不含 board.create） */
  contentCount: number;
  isCurrent: boolean;
}

export interface BoardsPanelCallbacks {
  list: () => Promise<BoardSummary[]>;
  onSwitch: (boardId: string) => Promise<void>;
  onCreate: (title: string) => Promise<void>;
  onRename: (boardId: string, title: string) => Promise<void>;
  onDelete: (boardId: string) => Promise<void>;
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (el === null) throw new Error(`板面板里找不到元素：${selector}`);
  return el;
}

function humanTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

export class BoardsPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly listBox: HTMLElement;
  private readonly note: HTMLElement;
  private readonly newBtn: HTMLButtonElement;
  /** 哪个板正在被改名（行内编辑） */
  private renaming: string | null = null;
  /** 哪个板的删除按钮已经"上膛" */
  private armedDelete: string | null = null;

  constructor(private readonly callbacks: BoardsPanelCallbacks) {
    this.dialog = must<HTMLDialogElement>(document, '#boards');
    this.listBox = must<HTMLElement>(this.dialog, '#boards-list');
    this.note = must<HTMLElement>(this.dialog, '#boards-note');
    this.newBtn = must<HTMLButtonElement>(this.dialog, '#boards-new');

    must<HTMLButtonElement>(this.dialog, '#close-boards').addEventListener('click', () => {
      this.dialog.close();
    });

    this.newBtn.addEventListener('click', () => {
      void this.run(async () => {
        await this.callbacks.onCreate(this.suggestNewTitle());
        this.note.textContent = '已新建一块板。';
        await this.refresh();
      });
    });
  }

  async open(): Promise<void> {
    this.renaming = null;
    this.armedDelete = null;
    this.note.textContent = '';
    await this.refresh();
    this.dialog.showModal();
  }

  /** 新板默认叫「新主题」，重名就加序号 */
  private suggestNewTitle(): string {
    return `新主题 ${new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`;
  }

  private async run(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (err) {
      console.error('板操作失败：', err);
      this.note.textContent = `失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async refresh(): Promise<void> {
    const boards = await this.callbacks.list();
    this.listBox.replaceChildren();

    for (const summary of boards) {
      this.listBox.append(
        this.renaming === summary.board.id ? this.renameRow(summary) : this.row(summary),
      );
    }
  }

  private row(summary: BoardSummary): HTMLElement {
    const row = document.createElement('div');
    row.className = summary.isCurrent ? 'board-row board-row--current' : 'board-row';

    // 主体部分点一下就能切过去
    const main = document.createElement('button');
    main.className = 'board-row__main';
    main.type = 'button';
    main.addEventListener('click', () => {
      if (summary.isCurrent) return;
      void this.run(async () => {
        await this.callbacks.onSwitch(summary.board.id);
        this.note.textContent = `已切到「${summary.board.title}」。`;
        this.armedDelete = null;
        await this.refresh();
      });
    });

    const title = document.createElement('span');
    title.className = 'board-row__title';
    title.textContent = summary.board.title;
    if (summary.isCurrent) {
      const tag = document.createElement('span');
      tag.className = 'tag tag--ok';
      tag.textContent = '正在看';
      title.append(tag);
    }

    const meta = document.createElement('span');
    meta.className = 'board-row__meta';
    meta.textContent =
      summary.contentCount === 0
        ? `${humanTime(summary.board.updatedAt)} · 还是空的`
        : `${humanTime(summary.board.updatedAt)} · ${summary.contentCount} 处内容`;

    main.append(title, meta);
    row.append(main);

    const actions = document.createElement('div');
    actions.className = 'board-row__actions';

    const rename = document.createElement('button');
    rename.className = 'btn';
    rename.type = 'button';
    rename.textContent = '改名';
    rename.addEventListener('click', () => {
      this.renaming = summary.board.id;
      this.armedDelete = null;
      void this.refresh();
    });
    actions.append(rename);

    // 删除要两步 —— 第一步只是"上膛"，把后果写清楚
    const remove = document.createElement('button');
    remove.className = 'btn btn--danger';
    remove.type = 'button';
    remove.textContent = this.armedDelete === summary.board.id ? '再点一次，确认删' : '删除';
    remove.disabled = summary.isCurrent && summary.contentCount === 0;
    remove.addEventListener('click', () => {
      if (this.armedDelete !== summary.board.id) {
        this.armedDelete = summary.board.id;
        this.renaming = null;
        this.note.textContent = `删除「${summary.board.title}」会连它的笔迹、截图、全部历史一起删掉，不可撤销。`;
        void this.refresh();
        return;
      }
      this.armedDelete = null;
      void this.run(async () => {
        await this.callbacks.onDelete(summary.board.id);
        this.note.textContent = `已删除「${summary.board.title}」。`;
        await this.refresh();
      });
    });
    actions.append(remove);

    row.append(actions);
    return row;
  }

  private renameRow(summary: BoardSummary): HTMLElement {
    const row = document.createElement('div');
    row.className = 'board-row board-row--editing';

    const input = document.createElement('input');
    input.className = 'field__input';
    input.type = 'text';
    input.value = summary.board.title;
    input.setAttribute('aria-label', '板的名字');

    const actions = document.createElement('div');
    actions.className = 'board-row__actions';

    const commit = (): void => {
      const title = input.value.trim();
      if (title === '') {
        this.note.textContent = '名字不能是空的。';
        return;
      }
      this.renaming = null;
      void this.run(async () => {
        await this.callbacks.onRename(summary.board.id, title);
        this.note.textContent = `已改名为「${title}」。`;
        await this.refresh();
      });
    };

    const save = document.createElement('button');
    save.className = 'btn btn--primary';
    save.type = 'button';
    save.textContent = '保存';
    save.addEventListener('click', commit);

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => {
      this.renaming = null;
      void this.refresh();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') {
        this.renaming = null;
        void this.refresh();
      }
    });

    actions.append(save, cancel);
    row.append(input, actions);

    // 打开面板时光标已经在输入框里，不用再点一下
    queueMicrotask(() => {
      input.focus();
      input.select();
    });

    return row;
  }
}
