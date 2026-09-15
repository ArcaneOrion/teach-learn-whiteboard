/** @vitest-environment jsdom */

/**
 * saveFile 的契约测试
 *
 * 这里盯的是一件很容易被"桌面浏览器上试过了，没问题"骗过去的事：
 * **同一次点击，在浏览器和安卓上走的是两条完全不同的路**。
 * 桌面那条是 <a download>；安卓 WebView 里那条是死的，必须写文件 + 拉起分享面板。
 *
 * 所以两条路都要单独验，尤其是「安卓上真的调了 Filesystem 和 Share」——
 * 光断言"没抛错"是没用的：原来那套代码在安卓上也不抛错，它只是**什么都不做**。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  share: vi.fn(),
  /** 测试里手动切换"现在在不在原生平台上" */
  native: { value: false },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.native.value },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE', Documents: 'DOCUMENTS' },
  Filesystem: { writeFile: mocks.writeFile },
}));

vi.mock('@capacitor/share', () => ({
  Share: { share: mocks.share },
}));

import { saveBlob } from './saveFile';

let clicked: HTMLAnchorElement[];

beforeEach(() => {
  mocks.writeFile.mockReset();
  mocks.share.mockReset();
  mocks.native.value = false;
  clicked = [];

  // jsdom 没有实现这两个
  URL.createObjectURL = vi.fn(() => 'blob:fake');
  URL.revokeObjectURL = vi.fn();

  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
});

describe('桌面浏览器这条路', () => {
  it('用 <a download> 把文件交出去，并告诉用户去「下载」里找', async () => {
    const hint = await saveBlob(new Blob(['x']), '备份.json');

    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('备份.json');
    expect(clicked[0]?.href).toBe('blob:fake');
    expect(hint).toContain('下载');

    // 不碰原生插件
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('交给用户之后把 <a> 从文档里摘掉，不留垃圾节点', async () => {
    await saveBlob(new Blob(['x']), 'a.json');
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });
});

describe('安卓这条路', () => {
  beforeEach(() => {
    mocks.native.value = true;
  });

  it('先写进 App 缓存目录，再把文件地址交给系统分享面板', async () => {
    mocks.writeFile.mockResolvedValue({ uri: 'file:///data/cache/备份.json' });
    mocks.share.mockResolvedValue({ activityType: '' });

    const hint = await saveBlob(new Blob(['hello']), '备份.json');

    // 写的内容必须是**真的文件内容**（base64），不是 "[object Blob]"
    expect(mocks.writeFile).toHaveBeenCalledWith({
      path: '备份.json',
      data: 'aGVsbG8=', // 'hello' 的 base64
      directory: 'CACHE',
      recursive: true,
    });

    // ★ 关键：分享的是刚写出来的那个地址
    expect(mocks.share).toHaveBeenCalledWith(
      expect.objectContaining({ files: ['file:///data/cache/备份.json'] }),
    );

    expect(hint).not.toBeNull();
    // 安卓上不存在"下载文件夹"这回事，提示里不能再提它
    expect(hint).not.toContain('下载');
  });

  it('不能走 <a download> —— 那条路在 WebView 里是死的', async () => {
    mocks.writeFile.mockResolvedValue({ uri: 'file:///x' });
    mocks.share.mockResolvedValue({});

    await saveBlob(new Blob(['x']), 'x.json');

    expect(clicked).toHaveLength(0);
  });

  it('用户划掉分享面板 = 取消，不是失败（不能抛错、要返回 null）', async () => {
    mocks.writeFile.mockResolvedValue({ uri: 'file:///x' });
    mocks.share.mockRejectedValue(new Error('Share canceled'));

    await expect(saveBlob(new Blob(['x']), 'x.json')).resolves.toBeNull();
  });

  it('真的失败（比如写文件就失败了）要抛出去，不能假装成功', async () => {
    mocks.writeFile.mockRejectedValue(new Error('磁盘满了'));

    await expect(saveBlob(new Blob(['x']), 'x.json')).rejects.toThrow('磁盘满了');
  });
});