/**
 * 把板面拍成一张图 —— 让 AI「看见」用户的笔迹（技术文档 §12）
 *
 * 这是整个产品「一起学」和「各说各话」的分界线：
 * 你画了个圈、打了个问号，它**看得见**。
 *
 * ## 原理
 *
 * AI 看不见画布上的像素。唯一的办法是把板面**光栅化成图片**，作为「图片输入」发给模型。
 *
 * 难点在于板面是**两层**：
 *   · 内容层是 DOM（AI 写的 HTML）—— 没法直接画到 canvas 上
 *   · 墨迹层是 canvas —— 本来就能导出
 *
 * 做法是用 SVG 的 `<foreignObject>`：它能把一段 HTML 塞进 SVG 里，
 * 而 SVG 可以当作图片画进 canvas。所以：
 *
 *   DOM 克隆 + 把 canvas 换成它的位图 → 包进 foreignObject → 变成 SVG 图片
 *     → drawImage 到 canvas → toBlob
 *
 * ## ⚠️ 三个踩过的坑（都是实测出来的）
 *
 * 1. **CSS 必须用 CDATA 包住**。样式表里可能有 `<` 或 `&`，当普通文本塞进 XML
 *    会让 XML 解析失败 —— 而且报错信息会指向完全无关的位置（比如说是 MathML 标签不匹配）。
 *
 * 2. **`<canvas>` 在 foreignObject 里不会自己画出来**，必须手动换成它自己的位图。
 *
 * 3. **生产构建里 CSS 是 `<link>` 而不是 `<style>`**，所以要额外把外链样式表的
 *    内容抓回来内联进去，否则拍出来的图完全没有样式。
 */

export interface Snapshot {
  blob: Blob;
  /** 图片像素尺寸（已含缩放） */
  width: number;
  height: number;
  /** 缩放比例（1 = 没缩） */
  scale: number;
}

export interface RasterizeOptions {
  /** 要拍的板面元素 */
  board: HTMLElement;
  /** 决定拍多大的容器（一般传滚动容器 → 拍的就是"当前看到的那一屏"） */
  viewport: HTMLElement;
  /**
   * 像素总数上限。超过就等比缩小。
   * 默认约 1.9M 像素（约等于 1400×1400）—— 模型对单图有预算，太大既慢又费钱。
   */
  maxPixels?: number;
  /** 输出格式。默认 PNG；超大时调用方可以改用 JPEG */
  type?: 'image/png' | 'image/jpeg';
  quality?: number;
}

const DEFAULT_MAX_PIXELS = 1_900_000;

/** 把 canvas 换成它自己的位图（否则 foreignObject 里是一片空白） */
function replaceCanvasWithImage(original: HTMLElement, clone: HTMLElement): void {
  const sources = original.querySelectorAll('canvas');
  const targets = clone.querySelectorAll('canvas');
  for (let i = 0; i < sources.length && i < targets.length; i += 1) {
    const src = sources[i];
    const dst = targets[i];
    if (src === undefined || dst === undefined || dst.parentNode === null) continue;

    const img = document.createElement('img');
    try {
      img.setAttribute('src', src.toDataURL('image/png'));
    } catch {
      // 极少数情况（canvas 被跨域内容污染）会抛。跳过它，别让整张截图失败
      continue;
    }
    const style = window.getComputedStyle(src);
    img.setAttribute(
      'style',
      `position:absolute;left:${style.left};top:${style.top};` +
        `width:${style.width};height:${style.height};`,
    );
    dst.parentNode.replaceChild(img, dst);
  }
}

/**
 * 收集页面上所有样式表的内容，内联成一段 CSS 文本。
 *
 * 为什么不能只读 `<style>`：生产构建会把 CSS 抽成 `<link rel=stylesheet>`，
 * 只读 `<style>` 的话拍出来的图会是完全没样式的裸 HTML —— 而且不报错。
 */
async function collectCss(): Promise<string> {
  const parts: string[] = [];

  for (const node of document.querySelectorAll('style')) {
    parts.push(node.textContent ?? '');
  }

  const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')];
  await Promise.all(
    links.map(async (link) => {
      try {
        const res = await fetch(link.href);
        if (res.ok) parts.push(await res.text());
      } catch {
        // 外链样式取不到就算了：图会难看一点，但不该让截图整个失败
      }
    }),
  );

  return parts.join('\n');
}

/** CDATA 里不能直接出现 `]]>`，要拆开写 */
function cdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('板面转成图片失败（SVG 没能加载）'));
    img.src = src;
  });
}

/**
 * 拍一张板面。
 *
 * @throws 当排版无法序列化成合法 XML 时（例如 AI 写的 HTML 里有无法序列化的节点）
 */
export async function rasterizeBoard(options: RasterizeOptions): Promise<Snapshot> {
  const { board, viewport } = options;
  const dpr = window.devicePixelRatio || 1;

  const boardRect = board.getBoundingClientRect();
  const viewRect = viewport.getBoundingClientRect();

  // 拍「当前看到的那一屏」而不是整块长板 —— 所见即所得，也符合用户圈的是哪一块
  const cssWidth = Math.max(1, Math.round(viewRect.width));
  const cssHeight = Math.max(1, Math.round(viewRect.height));
  const scrollTop = viewport.scrollTop;

  const clone = board.cloneNode(true) as HTMLElement;
  replaceCanvasWithImage(board, clone);
  clone.setAttribute(
    'style',
    `position:absolute;left:0;top:${-scrollTop}px;` +
      `width:${boardRect.width}px;height:${boardRect.height}px;`,
  );

  const css = await collectCss();
  const html = new XMLSerializer().serializeToString(clone);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cssWidth}" height="${cssHeight}" ` +
    `viewBox="0 0 ${cssWidth} ${cssHeight}">` +
    `<foreignObject x="0" y="0" width="${cssWidth}" height="${cssHeight}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${cssWidth}px;height:${cssHeight}px;overflow:hidden">` +
    `<style>${cdata(css)}</style>${html}</div></foreignObject></svg>`;

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await loadImage(url);

  // 像素总数太大就等比缩小（模型对单图有预算）
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const rawPixels = cssWidth * dpr * cssHeight * dpr;
  const scale = rawPixels > maxPixels ? Math.sqrt(maxPixels / rawPixels) : 1;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cssWidth * dpr * scale));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr * scale));

  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('拿不到 2D 上下文，没法生成截图');

  ctx.scale(dpr * scale, dpr * scale);
  ctx.drawImage(image, 0, 0, cssWidth, cssHeight);

  const type = options.type ?? 'image/png';
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, options.quality ?? 0.85);
  });
  if (blob === null) throw new Error('生成截图失败');

  return { blob, width: canvas.width, height: canvas.height, scale };
}

/** Blob → base64（不带 data: 前缀），发给模型时要用这个形式 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Blob → data URL（界面里显示缩略图用） */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取截图失败'));
    reader.readAsDataURL(blob);
  });
}
