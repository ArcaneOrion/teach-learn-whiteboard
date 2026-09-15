/**
 * 「把一份文件交给用户」—— 桌面浏览器和安卓走的是**两条完全不同的路**。
 *
 * ## 为什么不能只写一个 <a download>
 *
 * 桌面浏览器：造个 blob: URL 挂在 <a download> 上点一下，文件进「下载」文件夹。
 *
 * 安卓 WebView：**什么都不会发生**。不是报错，是静默无反应 ——
 * WebView 的下载必须由宿主 App 主动 `setDownloadListener` 接管，
 * 而 Capacitor 没有装它（在 @capacitor/android 的源码里搜不到这个调用）。
 *
 * 这个坑最坏的地方是它的**不对称**：
 * 导入走的是 `<input type="file">`，那条路 Capacitor 是实现了的（会弹系统文件选择器），
 * 所以症状表现为「导入好使、导出按下去没反应」—— 用户只会怀疑是自己按错了。
 * 而导出是这套东西**唯一的**备份手段：没有它，卸载重装 = 全部学习记录蒸发。
 *
 * ## 安卓这条路怎么走
 *
 * ① 写进 App 自己的缓存目录（`Directory.Cache`，**不需要任何权限**）；
 * ② 拉起系统分享面板 —— 用户在那里选「保存到文件」「存到相册」，或直接发给别人。
 *
 * 故意**不**写 `Directory.Documents`：那是公共 Documents 目录，Android 11+ 上要额外
 * 权限或 SAF 授权，跟这个项目「零危险权限」的目标冲突。
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

import { blobToBase64 } from '../base64';

/** 桌面浏览器那条路：blob → `<a download>` */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让某些浏览器来不及下载，延后一点
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 保存一份文件。
 *
 * @returns 「去哪里找它」这句话（调用方拼进给用户看的提示里）；
 *          原生平台上用户主动取消了分享，返回 `null`。
 */
export async function saveBlob(blob: Blob, fileName: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) {
    downloadBlob(blob, fileName);
    return '去浏览器的「下载」里找它。';
  }

  // 先把内容落到磁盘 —— 分享面板需要的是一个真实存在的 file:// 地址
  const written = await Filesystem.writeFile({
    path: fileName,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  });

  try {
    await Share.share({
      title: fileName,
      files: [written.uri],
      dialogTitle: '保存或发送这份文件',
    });
  } catch (err) {
    // 用户划掉分享面板不算失败，别弹「失败：...」
    if (isCancel(err)) return null;
    throw err;
  }

  return '在刚弹出的面板里选「保存到文件」就能留下来（也可以直接发给别人）。';
}

/** Share 插件在用户取消时会 reject，消息里带 cancel */
function isCancel(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(message);
}