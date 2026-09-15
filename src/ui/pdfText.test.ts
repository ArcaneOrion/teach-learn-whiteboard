/**
 * PDF 相关的纯逻辑测试
 *
 * 抽文字本身依赖 pdf.js 和真实文件，放在浏览器里验（见提交信息）。
 * 这里测的是**页码映射** —— 它错了不会报错，只会让用户按图索骥翻到错的一页。
 */

import { describe, expect, it } from 'vitest';

import { looksLikePdf, pageOfOffset } from './pdfText';

describe('pageOfOffset', () => {
  it('偏移落在第一页', () => {
    expect(pageOfOffset([0, 100, 200], 0)).toBe(1);
    expect(pageOfOffset([0, 100, 200], 50)).toBe(1);
    expect(pageOfOffset([0, 100, 200], 99)).toBe(1);
  });

  it('★ 正好落在某页的起点时，算那一页（不是上一页）', () => {
    expect(pageOfOffset([0, 100, 200], 100)).toBe(2);
    expect(pageOfOffset([0, 100, 200], 200)).toBe(3);
  });

  it('超过最后一页起点的一律算最后一页', () => {
    expect(pageOfOffset([0, 100, 200], 9999)).toBe(3);
  });

  it('只有一页', () => {
    expect(pageOfOffset([0], 0)).toBe(1);
    expect(pageOfOffset([0], 500)).toBe(1);
  });

  it('空数组不炸（返回第 1 页）', () => {
    expect(pageOfOffset([], 0)).toBe(1);
    expect(pageOfOffset([], 500)).toBe(1);
  });

  it('★ 页码只增不减 —— 偏移越大页码越靠后', () => {
    const starts = [0, 120, 300, 700];
    let previous = 0;
    for (let offset = 0; offset <= 800; offset += 7) {
      const page = pageOfOffset(starts, offset);
      expect(page).toBeGreaterThanOrEqual(previous);
      previous = page;
    }
    expect(previous).toBe(4);
  });
});

describe('looksLikePdf', () => {
  const fake = (name: string, type: string): File => new File(['x'], name, { type });

  it('按 MIME 认', () => {
    expect(looksLikePdf(fake('a.bin', 'application/pdf'))).toBe(true);
  });

  it('按扩展名认（有些系统不给 MIME）', () => {
    expect(looksLikePdf(fake('书.pdf', ''))).toBe(true);
    expect(looksLikePdf(fake('BOOK.PDF', ''))).toBe(true);
  });

  it('别的格式不误判', () => {
    expect(looksLikePdf(fake('notes.md', 'text/markdown'))).toBe(false);
    expect(looksLikePdf(fake('a.pdf.txt', 'text/plain'))).toBe(false);
  });
});
