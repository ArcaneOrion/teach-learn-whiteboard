/**
 * 渠道设置面板
 *
 * 产品定位是 BYOK —— 自己配 Key（产品文档 §3.3）。
 * 所以这个面板**可以直白地暴露技术概念**（Base URL、模型 ID），不做"傻瓜化"包装。
 *
 * ★ 界面上要写清楚的一句话：**Key 只在这台设备上，不会上传。**
 *   这不是口号 —— 代码里根本没有上传 Key 的路径（请求是设备直连模型厂商的）。
 */

import type { ChannelConfig } from '../ai/channels';

export interface SettingsPanelCallbacks {
  /** 用户新增了一个渠道 */
  onAdd: (channel: ChannelConfig) => Promise<void>;
  /** 用户删掉了一个渠道 */
  onRemove: (channelId: string) => Promise<void>;
  /** 面板打开时，需要重新读一遍渠道列表 */
  onOpen: () => Promise<readonly ChannelConfig[]>;
  /** 生成一个新渠道的 id */
  newId: () => string;
}

function el<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`设置面板里找不到元素：${selector}`);
  return found;
}

export class SettingsPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly urlInput: HTMLInputElement;
  private readonly keyInput: HTMLInputElement;
  private readonly modelsInput: HTMLInputElement;

  constructor(
    private readonly callbacks: SettingsPanelCallbacks,
    private readonly setKey: (channelId: string, key: string) => Promise<void>,
  ) {
    this.dialog = el<HTMLDialogElement>(document, '#settings');
    this.list = el<HTMLElement>(this.dialog, '#channel-list');
    this.nameInput = el<HTMLInputElement>(this.dialog, '#f-name');
    this.urlInput = el<HTMLInputElement>(this.dialog, '#f-url');
    this.keyInput = el<HTMLInputElement>(this.dialog, '#f-key');
    this.modelsInput = el<HTMLInputElement>(this.dialog, '#f-models');

    el<HTMLButtonElement>(this.dialog, '#close-settings').addEventListener('click', () => {
      this.dialog.close();
    });
    el<HTMLButtonElement>(this.dialog, '#f-add').addEventListener('click', () => {
      void this.addFromForm();
    });
  }

  async open(): Promise<void> {
    await this.refresh();
    this.dialog.showModal();
  }

  async refresh(): Promise<void> {
    const channels = await this.callbacks.onOpen();
    this.render(channels);
  }

  private render(channels: readonly ChannelConfig[]): void {
    this.list.replaceChildren();

    if (channels.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      // ⚠️ 别在这里提"开发模式的演示渠道" —— 生产构建里它根本不存在，那句话会说错话
      empty.textContent = '还没有配置任何渠道。在下面添加一个 —— 任何 OpenAI 兼容的端点都行。';
      this.list.append(empty);
      return;
    }

    for (const channel of channels) {
      const row = document.createElement('div');
      row.className = 'channel-row';

      const main = document.createElement('div');
      main.className = 'channel-row__main';

      const name = document.createElement('div');
      name.className = 'channel-row__name';
      name.textContent = channel.name;
      if (channel.unstable) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '可能不稳定';
        name.append(tag);
      }

      const meta = document.createElement('div');
      meta.className = 'channel-row__meta';
      meta.textContent =
        channel.kind === 'user'
          ? `${channel.baseUrl} · ${channel.modelIds.join(', ') || '（没填模型）'}`
          : '内置渠道 · 无需 Key';

      main.append(name, meta);
      row.append(main);

      if (channel.kind === 'user') {
        const remove = document.createElement('button');
        remove.className = 'btn btn--danger';
        remove.type = 'button';
        remove.textContent = '删除';
        remove.addEventListener('click', () => {
          void this.callbacks.onRemove(channel.id).then(() => this.refresh());
        });
        row.append(remove);
      }

      this.list.append(row);
    }
  }

  private async addFromForm(): Promise<void> {
    const name = this.nameInput.value.trim();
    const baseUrl = this.urlInput.value.trim();
    const key = this.keyInput.value.trim();
    const modelIds = this.modelsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    if (name === '' || baseUrl === '' || modelIds.length === 0) {
      window.alert('名称、Base URL、模型 ID 都要填。');
      return;
    }

    const channel: ChannelConfig = {
      id: this.callbacks.newId(),
      name,
      baseUrl,
      modelIds,
      kind: 'user',
      unstable: false,
    };

    await this.callbacks.onAdd(channel);
    if (key !== '') await this.setKey(channel.id, key);

    // 清空表单，但**不关面板** —— 用户可能还要再加一个
    this.nameInput.value = '';
    this.urlInput.value = '';
    this.keyInput.value = '';
    this.modelsInput.value = '';

    await this.refresh();
  }
}
