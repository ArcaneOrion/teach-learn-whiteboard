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
import type { FeedbackRating } from '../core/types';
import { sanitizeBoardHtml } from '../sanitize';
import { planRender } from './renderPlan';

/** 表态对应的图标与说明 */
const FEEDBACK_BADGE: Record<FeedbackRating, { icon: string; label: string }> = {
  useful: { icon: '👍', label: '你说这条有用' },
  useless: { icon: '👎', label: '你说这条没用' },
  wrong: { icon: '❌', label: '你说这条讲错了' },
};

export class ContentLayer {
  /** key → DOM 元素 */
  private readonly nodes = new Map<string, HTMLElement>();
  /** key → 当前那块**原始**（未净化）的 html，用于和下次比较，判断要不要更新 */
  private readonly html = new Map<string, string>();

  constructor(private readonly root: HTMLElement) {}

  /**
   * 按板面块更新内容层。只做最小改动，不做整块重建。
   *
   * @param feedback 被评价的事件 id → 表态。有表态的块右侧会挂一个小徽标
   */
  render(
    blocks: readonly BoardBlock[],
    feedback: Record<string, FeedbackRating> = {},
    options: { showHint?: boolean } = {},
  ): void {
    this.setHint(options.showHint === true && blocks.length === 0);

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

    // 3) 徽标 + 来源事件标记。每轮都刷一遍（表态可以改）
    for (const block of blocks) {
      const key = block.region !== null ? `r:${block.region}` : null;
      if (key === null) continue;
      const el = this.nodes.get(key);
      if (el === undefined) continue;

      // 长按要给这条反馈，得知道它是哪条事件写出来的
      el.dataset['sourceEvent'] = block.sourceEventId;

      el.querySelector('.block__feedback')?.remove();
      const rating = feedback[block.sourceEventId];
      if (rating !== undefined) {
        const badge = document.createElement('span');
        badge.className = `block__feedback block__feedback--${rating}`;
        badge.textContent = FEEDBACK_BADGE[rating].icon;
        badge.title = FEEDBACK_BADGE[rating].label;
        el.append(badge);
      }
    }

    // 4) 按最终顺序重排。只在位置不对时才移动，避免无谓的 DOM 抖动
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

  /**
   * 空板上的引导。
   *
   * ## 为什么需要它
   *
   * 「共写画布」是一个**不常见的交互模型** —— 板就是唯一界面，AI 的话直接写进板里，
   * 而不是「聊天框 + 白板」两栏。一个全新用户打开 App 看到的是一块**完全空白**的板，
   * 没有任何东西告诉他：可以用手写、可以打字让 AI 写到**这里**、圈住它写的东西它看得见。
   *
   * ## 为什么不做成"写进板里的第一块"
   *
   * 那样会**污染用户的板** —— 他想要一块干净的板，却先多了一段系统写的内容，
   * 而且还会进事件日志、被同步、被搜到。所以它是**渲染层的东西，不是数据**。
   *
   * 它只在这块板**一个字都没有、一笔都没画**的时候出现，一旦有内容就消失。
   */
  private setHint(show: boolean): void {
    const existing = this.root.querySelector<HTMLElement>('.board-hint');

    if (!show) {
      existing?.remove();
      return;
    }
    if (existing !== null) return;

    const hint = document.createElement('div');
    hint.className = 'board-hint';

    const title = document.createElement('p');
    title.className = 'board-hint__title';
    title.textContent = '这块板是你的';

    const list = document.createElement('ul');
    list.className = 'board-hint__list';
    for (const line of [
      '直接用手指或笔在上面写、画、圈',
      '也可以在下面打字，让 AI 把讲解写到这块板上',
      '圈住它写的东西，点「👁 让 AI 看」—— 它就知道你哪里没懂',
    ]) {
      const li = document.createElement('li');
      li.textContent = line;
      list.append(li);
    }

    hint.append(title, list);
    this.root.append(hint);
  }

  /** 当前内容层里有几块（调试/测试用） */
  get count(): number {
    return this.nodes.size;
  }
}
