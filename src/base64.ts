/**
 * base64 与 Blob 互转
 *
 * 放在中立位置而不是塞进 ui/ —— 因为两边都要用：
 *   · ui/rasterize.ts  把截图交给模型（图片输入要 base64）
 *   · store/transfer.ts 把截图写进备份文件
 */

/** Blob → base64（**不带** `data:` 前缀 —— 发给模型和存进备份都是这个形式） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // 分块拼接：一次性展开几十万个参数会爆栈
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 → Blob */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/** Blob → data URL（界面上显示缩略图用） */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取数据失败'));
    reader.readAsDataURL(blob);
  });
}
