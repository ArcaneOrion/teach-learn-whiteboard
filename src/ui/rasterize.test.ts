/**
 * 截图管线里「把 canvas 换成位图」这一步的测试
 *
 * ## 为什么专门给它写测试
 *
 * 这一步里藏过一个**从 M3 一直存在、8 轮之后才发现**的 bug：
 * 换出来的 `<img>` 没带 id，于是 `#ink { z-index: 2 }` 失效 ——
 * img 掉到内容层（z-index 1）后面，被块的不透明背景整个盖住。
 *
 * 症状极具欺骗性：**落在块与块空隙里的笔迹看得见，压在内容块上的全没了**。
 * 也就是说，「让 AI 看」拍出来的图里，用户圈在公式上的笔迹一直是看不见的。
 *
 * 这个测试就是钉住它：**换出来的 img 必须继承原 canvas 的 id / class / z-index**。
 * 光测"img 出现了、尺寸对了"是抓不到这个 bug 的 —— 那些当时都是对的。
 */

/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';

import { replaceCanvasWithImage } from './rasterize';

/** jsdom 没有真正的 canvas 后端，手动给一个能用的 toDataURL */
function makeCanvas(id: string, className: string, cssW: number, cssH: number, dpr: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.id = id;
  canvas.className = className;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.toDataURL = () => 'data:image/png;base64,AAAA';
  return canvas;
}

function makeBoard(canvas: HTMLCanvasElement): HTMLElement {
  const board = document.createElement('div');
  board.id = 'board';
  board.append(canvas);
  return board;
}

beforeEach(() => {
  // 默认 1；下面有的用例会改成 2.5 之类的值
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
});

describe('replaceCanvasWithImage', () => {
  it('canvas 被换成了 img', () => {
    const canvas = makeCanvas('ink', '', 800, 600, 1);
    const board = makeBoard(canvas);
    const clone = board.cloneNode(true) as HTMLElement;

    replaceCanvasWithImage(board, clone);

    expect(clone.querySelector('canvas')).toBeNull();
    expect(clone.querySelector('img')).not.toBeNull();
  });

  it('★ img 带上了原 canvas 的 id —— 少了它，`#ink { z-index }` 就失效', () => {
    const canvas = makeCanvas('ink', '', 800, 600, 1);
    const board = makeBoard(canvas);
    const clone = board.cloneNode(true) as HTMLElement;

    replaceCanvasWithImage(board, clone);

    // 这一条就是那个 bug 的回归测试
    expect(clone.querySelector('img')?.id).toBe('ink');
  });

  it('★ class 也带过去', () => {
    const canvas = makeCanvas('ink', 'layer--ink is-panning', 800, 600, 1);
    const board = makeBoard(canvas);
    const clone = board.cloneNode(true) as HTMLElement;

    replaceCanvasWithImage(board, clone);

    expect(clone.querySelector('img')?.className).toBe('layer--ink is-panning');
  });

  it('★ z-index 也显式写一份（万一样式不是靠 id 给的）', () => {
    const canvas = makeCanvas('ink', '', 800, 600, 1);
    const board = makeBoard(canvas);
    const clone = board.cloneNode(true) as HTMLElement;

    replaceCanvasWithImage(board, clone);

    expect(clone.querySelector('img')?.getAttribute('style')).toContain('z-index');
  });

  it('★ 尺寸按「位图 ÷ devicePixelRatio」算，不是按当时的布局尺寸', () => {
    // 位图 2000×1500，dpr 2.5 → 逻辑尺寸应该是 800×600
    const canvas = makeCanvas('ink', '', 800, 600, 2.5);
    const board = makeBoard(canvas);
    const clone = board.cloneNode(true) as HTMLElement;

    Object.defineProperty(window, 'devicePixelRatio', { value: 2.5, configurable: true });
    replaceCanvasWithImage(board, clone);

    const style = clone.querySelector('img')?.getAttribute('style') ?? '';
    expect(style).toContain('width:800px');
    expect(style).toContain('height:600px');
  });

  /**
   * ⚠️ 诚实地说明这条测试的**边界**：
   *
   * 它钉的是"算尺寸的公式"，而不是复现那个压扁的 bug。
   * jsdom 的 `getComputedStyle` 不做布局，永远返回空字符串 ——
   * 所以哪怕把实现改回 `style.width`（就是出 bug 的那个写法），
   * 这条测试**照样会过**。
   *
   * 那个 bug 只能在真浏览器里复现（要真的量出"容器变矮了"）。
   * 所以：**尺寸这类依赖布局的东西，别指望 jsdom 能替你验。**
   */

  it('dpr 变了也不会把图压扁（用位图尺寸反推，不依赖"此刻的布局"）', () => {
    const canvas = makeCanvas('ink', '', 800, 600, 2);
    const board = makeBoard(canvas);
    const clone = board.cloneNode(true) as HTMLElement;

    // 位图是 1600×1200（dpr 2 时生成的），但现在的 dpr 是 2 —— 算出来还是 800×600
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    replaceCanvasWithImage(board, clone);

    const style = clone.querySelector('img')?.getAttribute('style') ?? '';
    expect(style).toContain('width:800px');
    expect(style).toContain('height:600px');
  });

  it('原 canvas 没有 id 时不硬塞一个', () => {
    const canvas = makeCanvas('', '', 800, 600, 1);
    const board = makeBoard(canvas);
    const clone = board.cloneNode(true) as HTMLElement;

    replaceCanvasWithImage(board, clone);

    expect(clone.querySelector('img')?.id).toBe('');
  });

  it('toDataURL 抛错时跳过它，不让整张截图失败', () => {
    const canvas = makeCanvas('ink', '', 800, 600, 1);
    canvas.toDataURL = () => {
      throw new Error('被跨域内容污染了');
    };
    const board = makeBoard(canvas);
    const clone = board.cloneNode(true) as HTMLElement;

    expect(() => replaceCanvasWithImage(board, clone)).not.toThrow();
    // 没换掉，但也没炸
    expect(clone.querySelector('canvas')).not.toBeNull();
  });

  it('多个 canvas 按顺序一一对应', () => {
    const board = document.createElement('div');
    const a = makeCanvas('a', '', 100, 100, 1);
    const b = makeCanvas('b', '', 200, 200, 1);
    board.append(a, b);
    const clone = board.cloneNode(true) as HTMLElement;

    replaceCanvasWithImage(board, clone);

    const imgs = [...clone.querySelectorAll('img')];
    expect(imgs.map((i) => i.id)).toEqual(['a', 'b']);
  });
});
