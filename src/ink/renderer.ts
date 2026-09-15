/**
 * 墨迹渲染器 —— 两段式渲染
 *
 * 问题：板子画久了会有几千条笔画。如果每次采样都把全部笔画重画一遍，会明显卡顿。
 *
 * 做法（对应技术文档 §5.4）：
 *   · 已完成的笔画 → 只画一次，存在一张「离屏画布」上
 *   · 正在画的那一笔 → 每帧清掉重画（只有一笔，很便宜）
 *   · 每帧合成：把离屏画布贴上来 + 画当前这一笔
 *
 * 这样每帧的绘制量只跟「当前这一笔有多长」有关，跟板上有多少笔画无关。
 */

import type { Stroke } from './strokes';
import { paintStroke } from './paint';

export class InkRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  /** 离屏画布：存放所有已完成的笔画 */
  private readonly committed: HTMLCanvasElement;
  private readonly committedCtx: CanvasRenderingContext2D;

  /** 正在画的那一笔（还没结束） */
  private active: Stroke | null = null;

  /** 画布的 CSS 尺寸 */
  private width = 0;
  private height = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** 读取全部已完成笔画。渲染器不拥有数据 —— 数据由上层持有（将来是事件日志折叠出来的） */
    private readonly getStrokes: () => readonly Stroke[],
  ) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('无法获取 2D 绘图上下文');
    this.ctx = ctx;

    this.committed = document.createElement('canvas');
    const cctx = this.committed.getContext('2d');
    if (cctx === null) throw new Error('无法获取离屏 2D 绘图上下文');
    this.committedCtx = cctx;
  }

  /**
   * 设置尺寸。
   *
   * ⚠️ 关键：canvas 的位图尺寸必须是「CSS 尺寸 × devicePixelRatio」，
   * 否则在手机上（DPR 通常 2~3）画出来的线会发虚 —— 这是新手最常踩的坑。
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.width = Math.max(1, cssWidth);
    this.height = Math.max(1, cssHeight);

    const pw = Math.max(1, Math.round(this.width * dpr));
    const ph = Math.max(1, Math.round(this.height * dpr));

    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      this.committed.width = pw;
      this.committed.height = ph;
      // 改了位图尺寸，离屏画布的内容会被清空 → 必须重画
      this.rebuildCommitted();
    }
    this.frame();
  }

  /** 开始一笔 */
  begin(stroke: Stroke): void {
    this.active = stroke;
    this.frame();
  }

  /** 这一笔有新采样点，重画一帧 */
  extend(): void {
    if (this.active === null) return;
    this.frame();
  }

  /** 这一笔结束：把它「烙」进离屏画布 */
  end(): void {
    if (this.active !== null) {
      paintStroke(this.committedCtx, this.active);
      this.active = null;
    }
    this.frame();
  }

  /** 丢弃正在画的那一笔（掌托误触、取消操作） */
  cancelActive(): void {
    this.active = null;
    this.frame();
  }

  /** 笔画列表变了（撤销、清空）→ 全部重画一遍离屏画布 */
  redrawAll(): void {
    this.rebuildCommitted();
    this.frame();
  }

  /** 当前设备像素比（由位图尺寸与 CSS 尺寸推出，避免两处各记一份） */
  private dpr(): number {
    return this.width > 0 ? this.committed.width / this.width : 1;
  }

  private rebuildCommitted(): void {
    const g = this.committedCtx;
    const dpr = this.dpr();

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.committed.width, this.committed.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const s of this.getStrokes()) paintStroke(g, s);
  }

  /** 合成一帧到可见画布 */
  private frame(): void {
    const g = this.ctx;
    const dpr = this.dpr();

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 之后都按 CSS 像素坐标绘制
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1) 已完成的笔画
    g.drawImage(this.committed, 0, 0, this.width, this.height);

    // 2) 正在画的那一笔
    if (this.active !== null) paintStroke(g, this.active);
  }
}
