/**
 * 「资料」面板（M7 / RAG）
 *
 * 产品定位（产品文档 §13）：**RAG 是「让 AI 去检索你上传的文件」**，
 * 不是「把整本书塞进上下文」。所以这里的动作只有三个：导入、看看有哪些、删掉。
 *
 * ⚠️ 两条刻意的边界要在界面上说清楚：
 *   · **资料只在这台设备上**，不同步（产品文档 §13：资料不出设备）
 *   · **不进备份** —— 原文件你自己有，重新导入即可
 */

import type { DocRecord } from '../store/types';

export interface MaterialsPanelCallbacks {
  list: () => Promise<DocRecord[]>;
  /** 导入一个文件，返回一句给用户看的结果说明 */
  import: (file: File) => Promise<string>;
  remove: (docId: string) => Promise<void>;
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (el === null) throw new Error(`资料面板里找不到元素：${selector}`);
  return el;
}

export class MaterialsPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly listBox: HTMLElement;
  private readonly note: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly importBtn: HTMLButtonElement;

  constructor(private readonly callbacks: MaterialsPanelCallbacks) {
    this.dialog = must<HTMLDialogElement>(document, '#materials');
    this.listBox = must<HTMLElement>(this.dialog, '#materials-list');
    this.note = must<HTMLElement>(this.dialog, '#materials-note');
    this.fileInput = must<HTMLInputElement>(this.dialog, '#materials-file');
    this.importBtn = must<HTMLButtonElement>(this.dialog, '#materials-import');

    must<HTMLButtonElement>(this.dialog, '#close-materials').addEventListener('click', () => {
      this.dialog.close();
    });

    this.importBtn.addEventListener('click', () => {
      this.fileInput.click();
    });

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      // 清空 value，这样同一个文件能再导入一次
      this.fileInput.value = '';
      if (file === undefined) return;
      void this.run(async () => {
        this.setNote('正在读文件…');
        this.setNote(await this.callbacks.import(file));
        await this.refresh();
      });
    });
  }

  async open(): Promise<void> {
    await this.refresh();
    this.note.textContent = '';
    this.dialog.showModal();
  }

  private setNote(text: string): void {
    this.note.textContent = text;
  }

  private async run(task: () => Promise<void>): Promise<void> {
    this.importBtn.disabled = true;
    try {
      await task();
    } catch (err) {
      console.error('资料操作失败：', err);
      this.setNote(`失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.importBtn.disabled = false;
    }
  }

  private async refresh(): Promise<void> {
    const docs = await this.callbacks.list();
    this.listBox.replaceChildren();

    if (docs.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有资料。导入一个 .txt 或 .md 文件试试。';
      this.listBox.append(empty);
      return;
    }

    for (const doc of docs) {
      const row = document.createElement('div');
      row.className = 'channel-row';

      const main = document.createElement('div');
      main.className = 'channel-row__main';

      const name = document.createElement('div');
      name.className = 'channel-row__name';
      name.textContent = doc.title;

      const meta = document.createElement('div');
      meta.className = 'channel-row__meta';
      meta.textContent = `${doc.fileName} · ${doc.chars} 字 · 切成 ${doc.chunkCount} 块`;

      main.append(name, meta);
      row.append(main);

      const remove = document.createElement('button');
      remove.className = 'btn btn--danger';
      remove.type = 'button';
      remove.textContent = '删除';
      remove.addEventListener('click', () => {
        void this.run(async () => {
          await this.callbacks.remove(doc.id);
          this.setNote(`已删除《${doc.title}》。`);
          await this.refresh();
        });
      });
      row.append(remove);

      this.listBox.append(row);
    }
  }
}
