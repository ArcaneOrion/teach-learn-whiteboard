/**
 * 渲染计划（纯逻辑，不碰 DOM）
 *
 * 解决的问题：AI 每次往板上写一点东西，我们**不能把整块板重新渲染一遍**。
 *
 * 整块重建的三个代价（技术文档 §4.2）：
 *   ① 冲掉用户的笔迹
 *   ② 把滚动位置顶回顶部 —— 用户正在看下面，一下子被拽回开头
 *   ③ 白烧 token（这条是 AI 侧的，但同一件事）
 *
 * 所以这里算出「最小改动计划」：哪些要新建、哪些要替换、哪些要删掉、最终什么顺序。
 * 它是纯函数，所以可以被测试直接覆盖 —— 而 DOM 那一层只是照着计划执行。
 */

import type { BoardBlock } from '../core/board';

/**
 * 给每个块算一个**稳定**的 key。
 *
 *   · 有区域名 → `r:区域名`。这是稳定的：`set` 替换内容时 key 不变，
 *     所以 DOM 元素能原地更新，而不是删了重建。
 *   · 没有区域名 → `u:序号`。未命名块只能追加（没有区域名就没法 set/remove），
 *     所以它们的相对顺序永远稳定，序号也就是稳定的。
 */
export function blockKey(block: BoardBlock, unnamedIndex: number): string {
  return block.region !== null ? `r:${block.region}` : `u:${unnamedIndex}`;
}

export interface RenderPlan {
  /** 要新建的块 */
  create: { key: string; html: string }[];
  /** 要替换内容的块 */
  update: { key: string; html: string }[];
  /** 要删掉的 key */
  remove: string[];
  /** 最终顺序（key 列表），DOM 层照这个顺序重排 */
  order: string[];
}

/**
 * 算出最小改动计划。
 *
 * @param blocks  折叠出来的板面块
 * @param current 内容层现在有什么：key → 当前 html（原始未净化的文本，用于比较）
 */
export function planRender(
  blocks: readonly BoardBlock[],
  current: ReadonlyMap<string, string>,
): RenderPlan {
  const order: string[] = [];
  const create: { key: string; html: string }[] = [];
  const update: { key: string; html: string }[] = [];

  let unnamedIndex = 0;
  for (const block of blocks) {
    const key = block.region !== null ? blockKey(block, 0) : blockKey(block, unnamedIndex++);
    order.push(key);

    const existing = current.get(key);
    if (existing === undefined) {
      create.push({ key, html: block.html });
    } else if (existing !== block.html) {
      // 位置不变、key 不变，只换内容 —— 这就是「set 区域」的落地
      update.push({ key, html: block.html });
    }
    // 内容也没变 → 什么都不做。这是最常见的路径（AI 只追加了一块，其它块原样不动）
  }

  const wanted = new Set(order);
  const remove: string[] = [];
  for (const key of current.keys()) {
    if (!wanted.has(key)) remove.push(key);
  }

  return { create, update, remove, order };
}
