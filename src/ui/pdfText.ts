/**
 * 从 PDF 里抽文字（M7 的资料导入）
 *
 * ## 为什么是「按需加载」
 *
 * pdf.js 很大（解析库 448 KB + worker 1.3 MB）。**没导入过 PDF 的人不该为它买单**，
 * 所以这里用动态 import —— 只有真的选了 .pdf 才会去下载它。
 * （和 pi-ai 的 provider 分块是同一个套路。）
 *
 * ## ⚠️ 中文 PDF 要靠 CMap
 *
 * pdf.js 解析中文 PDF 时，要拿 CMap 文件把字体里的 CID 编码映射回 Unicode。
 * 没有这些文件的话，很多中文书的文字**抽出来是空的或者乱码，而且不报错**。
 * 所以 `cMapUrl` 必须指向本地那份资源（由 scripts/sync-pdfjs-assets.mjs 复制）。
 *
 * 这一条特别容易被漏掉：拿一个英文 PDF 试是好的，就以为没问题了。
 */

export interface PdfExtract {
  /** 全文（页与页之间用空行隔开） */
  text: string;
  pages: number;
  /**
   * `pageStarts[i]` = 第 i+1 页的正文在 `text` 里的起始偏移。
   * 有了它，切块之后才能知道每一块来自**第几页** —— 引用原文时要标页码。
   */
  pageStarts: number[];
}

export interface PdfExtractOptions {
  /** 进度回调（页数多的时候界面要显示进度） */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 某个字符偏移落在第几页（从 1 开始）。
 *
 * 纯函数，单独拎出来是因为它值得测 —— 页码标错的话，
 * 用户按图索骥去翻书会翻到完全无关的一页。
 */
export function pageOfOffset(pageStarts: readonly number[], offset: number): number {
  let page = 1;
  for (let i = 0; i < pageStarts.length; i += 1) {
    const start = pageStarts[i];
    if (start !== undefined && start <= offset) page = i + 1;
    else break;
  }
  return page;
}

/** 抽一个 PDF 的文字。会按页返回，并记下每页的起始偏移 */
export async function extractPdfText(
  file: File,
  options: PdfExtractOptions = {},
): Promise<PdfExtract> {
  const pdfjs = await import('pdfjs-dist');

  // worker 单独一个文件，Vite 会把它也一起打包并按需加载
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = new Uint8Array(await file.arrayBuffer());

  // ⚠️ 销毁要调**加载任务**的 destroy()，不是文档对象的 ——
  //    文档上的那个方法在 pdf.js 6 里已经没有了（只有 cleanup）。
  //    不销毁的话 worker 会一直挂着，导完几本书就积一堆。
  const loadingTask = pdfjs.getDocument({
    data,
    // 中文 / 日文 / 韩文 PDF 全靠它。用 BASE_URL 拼，
    // 这样换到 Capacitor 的 file:// 环境也不会失效
    cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
  });

  const doc = await loadingTask.promise;

  const pageStarts: number[] = [];
  let text = '';

  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    // 只取文字项；一行一行的用空格接起来（pdf.js 给的是"文本片段"）
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text !== '') text += '\n\n';
    pageStarts.push(text.length);
    text += pageText;

    options.onProgress?.(i, doc.numPages);
  }

  await loadingTask.destroy();

  return { text, pages: doc.numPages, pageStarts };
}

/** 这个文件看起来是不是 PDF（按扩展名或 MIME） */
export function looksLikePdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}
