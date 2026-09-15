/**
 * 「数据与备份」面板
 *
 * ⚠️ 这个面板承载的是技术文档里标为**必需**的功能：
 * 数据存在 App 专属目录 / IndexedDB 里，**卸载即删**。
 * 没有导出，用户卸载重装就等于失去全部学习记录。
 *
 * 所以文案要直白说清「卸载会删掉」，而不是藏在某个角落。
 *
 * ## 刻意不用 window.confirm
 *
 * 原生弹窗有两个问题：
 *   ① 它**阻塞整个页面**（连渲染都停），而且长得跟 App 完全不一样
 *   ② 它说不了细节 —— 「要导入 15 条事件、2 张截图」这种话塞不进去
 * 所以导入和清空都改成**面板内的两步确认**：先把影响写清楚，再让用户点第二个按钮。
 */

import type { BackupFile } from '../core/backup';
import { describeBackup } from '../core/backup';

export interface DataStats {
  boards: number;
  sessions: number;
  events: number;
  attachments: number;
  /** 截图占用的字节数（数据里的大头） */
  attachmentBytes: number;
  /** 有几条 API Key（它们**不会**被导出） */
  credentials: number;
}

export interface SyncConfig {
  baseUrl: string;
  token: string;
  /** 自动同步开着吗（配了地址之后默认开） */
  auto?: boolean;
}

export interface DataPanelCallbacks {
  stats: () => Promise<DataStats>;
  /** 导出备份，返回一句「文件去哪了」给用户看（用户取消则返回 null） */
  onExport: () => Promise<string | null>;
  /** 解析备份文本（失败要抛错 —— 消息是给人看的） */
  parse: (text: string) => BackupFile;
  /** 真的导入 */
  onImport: (backup: BackupFile) => Promise<string>;
  /** 清空全部数据 */
  onReset: () => Promise<void>;

  /** 把当前这块板存成图片，返回一句给用户看的说明 */
  onExportImage: () => Promise<string>;

  // ── 同步 ────────────────────────────────────────────────────
  loadSyncConfig: () => Promise<SyncConfig>;
  saveSyncConfig: (config: SyncConfig) => Promise<void>;
  /** 跑一次同步，返回给用户看的结果说明 */
  onSync: (config: SyncConfig) => Promise<string>;
  /** 自动同步现在什么状态（给用户看的一句话） */
  autoSyncStatus: () => string;
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (el === null) throw new Error(`数据面板里找不到元素：${selector}`);
  return el;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class DataPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly statsBox: HTMLElement;
  private readonly confirmBox: HTMLElement;
  private readonly note: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly importBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;

  /** 等用户确认的导入；null = 没有待确认的 */
  private pendingImport: BackupFile | null = null;
  /** 清空按钮点过一次了吗（第一次只是"上膛"） */
  private resetArmed = false;

  constructor(private readonly callbacks: DataPanelCallbacks) {
    this.dialog = must<HTMLDialogElement>(document, '#data');
    this.statsBox = must<HTMLElement>(this.dialog, '#data-stats');
    this.confirmBox = must<HTMLElement>(this.dialog, '#data-confirm');
    this.note = must<HTMLElement>(this.dialog, '#data-note');
    this.fileInput = must<HTMLInputElement>(this.dialog, '#data-file');
    this.exportBtn = must<HTMLButtonElement>(this.dialog, '#data-export');
    this.importBtn = must<HTMLButtonElement>(this.dialog, '#data-import');
    this.resetBtn = must<HTMLButtonElement>(this.dialog, '#data-reset');

    must<HTMLButtonElement>(this.dialog, '#close-data').addEventListener('click', () => {
      this.dialog.close();
    });

    this.exportBtn.addEventListener('click', () => {
      void this.run(this.exportBtn, async () => {
        const hint = await this.callbacks.onExport();
        this.setNote(
          hint === null
            ? '已取消，没有导出。'
            : `已导出。${hint}把文件存到你找得回来的地方（网盘、电脑都行）。`,
        );
      });
    });

    this.importBtn.addEventListener('click', () => {
      this.disarm();
      this.fileInput.click();
    });

    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      // 清空 value，这样同一个文件能再选一次
      this.fileInput.value = '';
      if (file === undefined) return;
      void this.pickFile(file);
    });

    this.resetBtn.addEventListener('click', () => {
      if (!this.resetArmed) {
        this.armReset();
        return;
      }
      this.disarm();
      void this.run(this.resetBtn, async () => {
        await this.callbacks.onReset();
      });
    });

    // ── 存成图片 ──────────────────────────────────────────────
    this.exportImageNote = must<HTMLElement>(this.dialog, '#export-image-note');
    const exportImageBtn = must<HTMLButtonElement>(this.dialog, '#export-image');
    exportImageBtn.addEventListener('click', () => {
      void this.run(exportImageBtn, async () => {
        this.exportImageNote.textContent = '正在生成…';
        this.exportImageNote.textContent = await this.callbacks.onExportImage();
      });
    });

    // ── 同步 ──────────────────────────────────────────────────
    this.syncUrl = must<HTMLInputElement>(this.dialog, '#sync-url');
    this.syncToken = must<HTMLInputElement>(this.dialog, '#sync-token');
    this.syncStatus = must<HTMLElement>(this.dialog, '#sync-status');
    this.syncNowBtn = must<HTMLButtonElement>(this.dialog, '#sync-now');
    this.syncAuto = must<HTMLInputElement>(this.dialog, '#sync-auto');

    must<HTMLButtonElement>(this.dialog, '#sync-save').addEventListener('click', () => {
      const saveBtn = must<HTMLButtonElement>(this.dialog, '#sync-save');
      void this.run(saveBtn, async () => {
        await this.callbacks.saveSyncConfig(this.readSyncForm());
        this.setSyncStatus('设置已保存。');
      });
    });

    this.syncNowBtn.addEventListener('click', () => {
      const config = this.readSyncForm();
      if (config.baseUrl.trim() === '') {
        this.setSyncStatus('先填服务端地址。');
        return;
      }
      void this.run(this.syncNowBtn, async () => {
        this.setSyncStatus('正在同步…');
        // 顺手把设置存下来 —— 用户点了同步却忘了保存是很常见的事
        await this.callbacks.saveSyncConfig(config);
        this.setSyncStatus(await this.callbacks.onSync(config));
      });
    });
  }

  private readonly syncUrl: HTMLInputElement;
  private readonly syncToken: HTMLInputElement;
  private readonly syncStatus: HTMLElement;
  private readonly syncNowBtn: HTMLButtonElement;
  private readonly syncAuto: HTMLInputElement;
  private readonly exportImageNote: HTMLElement;

  private readSyncForm(): SyncConfig {
    return {
      baseUrl: this.syncUrl.value.trim(),
      token: this.syncToken.value,
      auto: this.syncAuto.checked,
    };
  }

  private setSyncStatus(text: string): void {
    this.syncStatus.textContent = text;
  }

  async open(): Promise<void> {
    const config = await this.callbacks.loadSyncConfig();
    this.syncUrl.value = config.baseUrl;
    this.syncToken.value = config.token;
    // 配了地址之后默认开自动同步 —— 用户既然填了地址，多半就是想让它是自动的
    this.syncAuto.checked = config.auto ?? config.baseUrl !== '';
    this.setSyncStatus(
      config.baseUrl === ''
        ? '还没配同步 —— 不配也不影响其他功能。'
        : this.callbacks.autoSyncStatus(),
    );
    this.exportImageNote.textContent = '';

    await this.refreshStats();
    this.disarm();
    this.dialog.showModal();
  }

  private setNote(text: string): void {
    this.note.textContent = text;
  }

  /** 清掉待确认状态（换操作时调用，避免"上膛"状态残留） */
  private disarm(): void {
    this.pendingImport = null;
    this.resetArmed = false;
    this.confirmBox.hidden = true;
    this.confirmBox.replaceChildren();
    this.resetBtn.textContent = '清空全部数据';
  }

  // ── 选择文件之后：先把「里面有什么」摆出来 ──────────────────

  private async pickFile(file: File): Promise<void> {
    let backup: BackupFile;
    try {
      backup = this.callbacks.parse(await file.text());
    } catch (err) {
      // core/backup.ts 抛出的消息本来就是给人看的
      this.setNote(`这个文件用不了：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    this.pendingImport = backup;

    const box = document.createElement('div');
    box.className = 'confirm__inner';

    const title = document.createElement('div');
    title.className = 'confirm__title';
    title.textContent = '这份备份里有：';

    const detail = document.createElement('pre');
    detail.className = 'confirm__detail';
    detail.textContent = describeBackup(backup);

    const warn = document.createElement('div');
    warn.className = 'confirm__hint';
    warn.textContent = '导入是「合并」，不会删掉现有的东西。同一个文件导两次也不会重复。';

    const actions = document.createElement('div');
    actions.className = 'confirm__actions';

    const confirm = document.createElement('button');
    confirm.className = 'btn btn--primary';
    confirm.type = 'button';
    confirm.id = 'data-import-confirm';
    confirm.textContent = '确认导入';
    confirm.addEventListener('click', () => {
      const target = this.pendingImport;
      if (target === null) return;
      void this.run(confirm, async () => {
        const message = await this.callbacks.onImport(target);
        this.setNote(message);
        this.disarm();
        await this.refreshStats();
      });
    });

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => {
      this.disarm();
      this.setNote('已取消导入。');
    });

    actions.append(confirm, cancel);
    box.append(title, detail, warn, actions);
    this.confirmBox.replaceChildren(box);
    this.confirmBox.hidden = false;
  }

  /** 清空：第一次点只是「上膛」，把后果写清楚 */
  private armReset(): void {
    this.resetArmed = true;
    this.resetBtn.textContent = '再点一次，确认清空';

    const box = document.createElement('div');
    box.className = 'confirm__inner confirm__inner--danger';

    const title = document.createElement('div');
    title.className = 'confirm__title';
    title.textContent = '这会删掉：';

    const detail = document.createElement('pre');
    detail.className = 'confirm__detail';
    detail.textContent = '所有板、笔迹、截图、学习记录 —— 全部。\n而且不可撤销。';

    const hint = document.createElement('div');
    hint.className = 'confirm__hint';
    hint.textContent = '还没导出备份的话，现在点「取消」，先导一份出来。';

    const actions = document.createElement('div');
    actions.className = 'confirm__actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => this.disarm());

    actions.append(cancel);
    box.append(title, detail, hint, actions);
    this.confirmBox.replaceChildren(box);
    this.confirmBox.hidden = false;
  }

  // ── 统计 ────────────────────────────────────────────────────

  private async refreshStats(): Promise<void> {
    const s = await this.callbacks.stats();
    this.statsBox.replaceChildren();

    const rows: [string, string][] = [
      ['板', `${s.boards} 块`],
      ['学习会话', `${s.sessions} 次`],
      ['事件（板的全部历史）', `${s.events} 条`],
      ['截图', `${s.attachments} 张 · ${humanBytes(s.attachmentBytes)}`],
    ];

    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'stat';
      const l = document.createElement('span');
      l.className = 'stat__label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'stat__value';
      v.textContent = value;
      row.append(l, v);
      this.statsBox.append(row);
    }

    // 凭据单独说一句 —— 用户会想知道「我的 Key 在不在备份里」
    const existing = this.statsBox.querySelector('.stat--hint');
    existing?.remove();
    if (s.credentials > 0) {
      const hint = document.createElement('p');
      hint.className = 'settings__foot stat--hint';
      hint.textContent = `（你填了 ${s.credentials} 个渠道的 Key。它们只在这台设备上，备份文件里没有。）`;
      this.statsBox.append(hint);
    }
  }

  /** 跑一个会改数据的操作：期间禁用按钮、出错说人话 */
  private async run(button: HTMLButtonElement, task: () => Promise<void>): Promise<void> {
    button.disabled = true;
    try {
      await task();
    } catch (err) {
      console.error('数据操作失败：', err);
      this.setNote(`失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      button.disabled = false;
    }
  }
}
