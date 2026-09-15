/**
 * HTML → 纯文本
 *
 * 检索需要的是**纯文本**：搜「section」不该把所有板面块都搜出来。
 * 而且这个转换必须是安全的 —— 用 DOMParser 解析**不会执行**脚本、也不会加载图片，
 * 它只是把标记拆成文本节点。
 *
 * 单独放一个文件而不是写进 core/search.ts，是为了让那一层保持纯净、可测试
 * （那边通过参数把转换函数注入进来）。
 */

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 样式和脚本的文字不该进检索（正常情况下已经被净化掉了，这里再兜一层）
  for (const node of doc.body.querySelectorAll('style, script')) {
    node.remove();
  }

  const text = doc.body.textContent ?? '';
  // 折叠空白：HTML 里的换行和缩进对搜索毫无意义，只会让摘要变难看
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 取一段「命中位置附近」的摘要。
 *
 * 直接把整段正文显示出来，用户扫一眼根本找不到那个词在哪。
 */
export function snippetAround(text: string, query: string, radius = 40): string {
  if (query === '') return text.slice(0, radius * 2);

  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return text.slice(0, radius * 2);

  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
