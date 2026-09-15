/**
 * 内容层 —— AI 写的板面内容
 *
 * 板面是三层的（技术文档 §5.1）：
 *
 *   ③ 墨迹层  canvas   ← 用户的笔迹，在最上面
 *   ② 内容层  div      ← AI 写的 HTML（本文件）
 *   ① 背景层  底色/网格
 *
 * 墨迹在最上层，所以用户能直接在 AI 写的东西上圈画；
 * 而 AI 更新内容层时**不会碰墨迹层**，用户的笔迹不会消失。
 *
 * ⚠️ 内容层整体 pointer-events: none —— 指针事件全部交给上面的墨迹层。
 *    这样「用笔在 AI 写的字上画圈」不需要任何特殊处理，天然成立。
 *    （将来 AI 要写可交互元素时，再像教学平面那样做命中测试转发点击。）
 */

import type { BoardBlock } from '../core/board';
import { sanitizeBoardHtml } from '../sanitize';
import { planRender } from './renderPlan';

export class ContentLayer {
  /** key → DOM 元素 */
  private readonly nodes = new Map<string, HTMLElement>();
  /** key → 当前那块**原始**（未净化）的 html，用于和下次比较，判断要不要更新 */
  private readonly html = new Map<string, string>();

  constructor(private readonly root: HTMLElement) {}

  /** 按板面块更新内容层。只做最小改动，不做整块重建。 */
  render(blocks: readonly BoardBlock[]): void {
    const plan = planRender(blocks, this.html);

    // 1) 删掉消失的块
    for (const key of plan.remove) {
      this.nodes.get(key)?.remove();
      this.nodes.delete(key);
      this.html.delete(key);
    }

    // 2) 新建 + 替换内容
    for (const item of [...plan.create, ...plan.update]) {
      let el = this.nodes.get(item.key);
      if (el === undefined) {
        el = document.createElement('section');
        el.className = 'block';
        this.nodes.set(item.key, el);
      }
      // ★ 必须净化：这段 HTML 来自模型，会被插进我们的页面（见 src/sanitize.ts 的说明）
      el.innerHTML = sanitizeBoardHtml(item.html);
      el.dataset['blockKey'] = item.key;
      this.html.set(item.key, item.html);
    }

    // 3) 按最终顺序重排。只在位置不对时才移动，避免无谓的 DOM 抖动
    let cursor: ChildNode | null = this.root.firstChild;
    for (const key of plan.order) {
      const el = this.nodes.get(key);
      if (el === undefined) continue;
      if (el === cursor) {
        cursor = el.nextSibling;
      } else {
        this.root.insertBefore(el, cursor);
      }
    }

    this.root.dataset['blockCount'] = String(plan.order.length);
  }

  /** 当前内容层里有几块（调试/测试用） */
  get count(): number {
    return this.nodes.size;
  }
}
