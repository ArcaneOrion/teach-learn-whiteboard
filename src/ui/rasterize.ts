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
   * `true` = 拍**整块板**（导出图片给用户用）；省略 = 拍当前看到的那一屏（给模型看用）。
   *
   * 为什么是两种模式而不是一种：
   *   · 给模型看 → 拍一屏，所见即所得，也符合"用户圈的是哪一块"
   *   · 给用户存 → 拍全部，他要的是完整笔记，不是一张屏幕截图
   */
  full?: boolean;
  /**
   * 显式指定拍多高（CSS 像素），覆盖上面两种模式。
   *
   * 导出图片时用它：板面底部有 45vh 的留白（那是给用户在最下面继续写字用的），
   * 全拍下来图的下半张全是空白。但**又不能去改板面布局** ——
   * 用户完全可能就在那片留白上写了东西，裁掉就丢了。
   * 所以：板面一动不动，只是告诉截图"拍这么高"。
   */
  height?: number;
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
  const dpr = window.devicePixelRatio || 1;

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

    /**
     * ★★ 必须把 id / class 带过去 —— 这是最难发现的一个 bug。
     *
     * 墨迹层的层叠顺序是靠 **id 选择器**定的：`#ink { z-index: 2 }`，
     * 而内容层是 `.layer--content { z-index: 1 }`。
     * 换成 `<img>` 之后如果没带 id，img 就没有 z-index，
     * 于是它**掉到内容层后面**，被块的**不透明背景整个盖住**。
     *
     * 症状极具欺骗性：**落在块与块空隙里的笔迹看得见，压在块上的笔迹全没了** ——
     * 看起来像"截图丢了一部分笔迹"，其实是层叠顺序问题。
     *
     * 而这个 bug 从 M3 就存在：「让 AI 看」拍出来的图里，
     * **压在 AI 写的字上面的圈画一直是看不见的** —— 恰恰是用户最想让它看的那种。
     * 当时的验证只确认了"模型能看到笔迹"，没确认"能看到压在文字上的笔迹"。
     */
    if (src.id !== '') img.id = src.id;
    img.className = src.className;

    const style = window.getComputedStyle(src);
    /**
     * ⚠️ 宽高**不能**用 `getComputedStyle` —— 它给的是"此刻的布局尺寸"，
     * 而位图是位图。两者一旦不一致，图就被**纵向或横向压扁**，而且不报错。
     *
     * 踩过的：导出时为了去掉底部那段 45vh 留白，临时把容器改矮了；
     * canvas 的 computed 高度跟着变矮，但位图还是原来那么高 ——
     * 于是笔迹被压扁、位置整体上移，看起来就像"笔迹没导出来"。
     *
     * 位图的真实逻辑尺寸永远是 `位图尺寸 / devicePixelRatio`
     * （渲染器就是按 `CSS 尺寸 × dpr` 设的位图，见 ink/renderer.ts 的 resize）。
     */
    const cssW = src.width / dpr;
    const cssH = src.height / dpr;
    // z-index 也显式写一份：万一样式是靠别的选择器给的，id/class 带过去还不够
    img.setAttribute(
      'style',
      `position:absolute;left:${style.left};top:${style.top};` +
        `width:${cssW}px;height:${cssH}px;z-index:${style.zIndex};`,
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
  const full = options.full === true;
  const dpr = window.devicePixelRatio || 1;

  const boardRect = board.getBoundingClientRect();
  const viewRect = viewport.getBoundingClientRect();

  // 默认拍「当前看到的那一屏」而不是整块长板 —— 所见即所得，
  // 也符合用户圈的是哪一块。导出给用户时才用 full / height 拍更多
  const cssWidth = Math.max(1, Math.round(full ? boardRect.width : viewRect.width));
  const cssHeight = Math.max(
    1,
    Math.round(options.height ?? (full ? boardRect.height : viewRect.height)),
  );
  const scrollTop = full ? 0 : viewport.scrollTop;

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
