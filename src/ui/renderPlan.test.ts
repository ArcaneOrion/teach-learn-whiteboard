/**
 * 渲染计划的单元测试
 *
 * 这块逻辑决定「AI 写板面时到底改动了哪些 DOM」。测它的理由很直接：
 * 一旦退化成"整块重建"，用户就会遇到笔迹消失、滚动被顶回顶部 ——
 * 而这两种症状都很难在人工点测中发现（要板子足够长才看得出来）。
 */

import { describe, expect, it } from 'vitest';

import type { BoardBlock } from '../core/board';
import { blockKey, planRender } from './renderPlan';

/** 渲染计划不关心 sourceEventId，这里给个占位值即可 */
const named = (region: string, html: string): BoardBlock => ({
  region,
  html,
  sourceEventId: `evt-${region}`,
});
const unnamed = (html: string): BoardBlock => ({ region: null, html, sourceEventId: `evt-${html}` });

/** 用一组块模拟"内容层现在的内容" */
function currentOf(blocks: readonly BoardBlock[]): Map<string, string> {
  const map = new Map<string, string>();
  let unnamedIndex = 0;
  for (const b of blocks) {
    map.set(b.region !== null ? blockKey(b, 0) : blockKey(b, unnamedIndex++), b.html);
  }
  return map;
}

describe('blockKey', () => {
  it('有区域名时用区域名，和位置无关', () => {
    expect(blockKey(named('讲解-1', 'x'), 0)).toBe('r:讲解-1');
    expect(blockKey(named('讲解-1', 'y'), 7)).toBe('r:讲解-1');
  });

  it('没有区域名时用未命名序号', () => {
    expect(blockKey(unnamed('x'), 0)).toBe('u:0');
    expect(blockKey(unnamed('x'), 3)).toBe('u:3');
  });

  it('有区域名和没区域名不会撞 key', () => {
    expect(blockKey(named('0', 'x'), 0)).not.toBe(blockKey(unnamed('x'), 0));
  });
});

describe('planRender', () => {
  it('内容层为空时全部新建，顺序就是块的顺序', () => {
    const plan = planRender([named('a', 'A'), named('b', 'B')], new Map());
    expect(plan.create.map((c) => c.key)).toEqual(['r:a', 'r:b']);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.order).toEqual(['r:a', 'r:b']);
  });

  it('★ 内容完全没变时什么都不做（最常见的路径）', () => {
    const blocks = [named('a', 'A'), named('b', 'B')];
    const plan = planRender(blocks, currentOf(blocks));

    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.order).toEqual(['r:a', 'r:b']);
  });

  it('★ 追加一块时，只有新块被新建，老块一个都不动', () => {
    const before = [named('a', 'A'), named('b', 'B')];
    const after = [...before, named('c', 'C')];
    const plan = planRender(after, currentOf(before));

    expect(plan.create).toEqual([{ key: 'r:c', html: 'C' }]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('★ set 某个区域时只更新那一块，key 保持不变（能原地替换而不是删了重建）', () => {
    const before = [named('a', 'A'), named('b', 'B'), named('c', 'C')];
    const after = [named('a', 'A'), named('b', 'B 改过了'), named('c', 'C')];
    const plan = planRender(after, currentOf(before));

    expect(plan.update).toEqual([{ key: 'r:b', html: 'B 改过了' }]);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
    // key 没变 → DOM 元素能原地更新
    expect(plan.order).toEqual(['r:a', 'r:b', 'r:c']);
  });

  it('remove 某个区域时只删那一块', () => {
    const before = [named('a', 'A'), named('b', 'B')];
    const after = [named('a', 'A')];
    const plan = planRender(after, currentOf(before));

    expect(plan.remove).toEqual(['r:b']);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
  });

  it('顺序变化时反映在 order 里', () => {
    const before = [named('a', 'A'), named('b', 'B')];
    const after = [named('b', 'B'), named('a', 'A')];
    const plan = planRender(after, currentOf(before));

    // 内容没变，所以不重建，只重排
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.order).toEqual(['r:b', 'r:a']);
  });

  it('未命名块按出现顺序编号，追加不影响已有的', () => {
    const before = [unnamed('第一段')];
    const after = [unnamed('第一段'), unnamed('第二段')];
    const plan = planRender(after, currentOf(before));

    expect(plan.create).toEqual([{ key: 'u:1', html: '第二段' }]);
    expect(plan.update).toEqual([]);
  });

  it('命名块和未命名块混在一起也能各自稳定', () => {
    const blocks = [named('a', 'A'), unnamed('自由段落'), named('b', 'B')];
    const plan = planRender(blocks, currentOf(blocks));
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.order).toEqual(['r:a', 'u:0', 'r:b']);
  });

  it('一次同时发生新建、更新、删除', () => {
    const before = [named('a', 'A'), named('b', 'B'), named('c', 'C')];
    const after = [named('a', 'A2'), named('d', 'D')];
    const plan = planRender(after, currentOf(before));

    expect(plan.create.map((c) => c.key)).toEqual(['r:d']);
    expect(plan.update.map((u) => u.key)).toEqual(['r:a']);
    expect(plan.remove.sort()).toEqual(['r:b', 'r:c']);
    expect(plan.order).toEqual(['r:a', 'r:d']);
  });

  it('清空板面时全部删除', () => {
    const before = [named('a', 'A'), named('b', 'B')];
    const plan = planRender([], currentOf(before));

    expect(plan.remove.sort()).toEqual(['r:a', 'r:b']);
    expect(plan.order).toEqual([]);
  });
});
