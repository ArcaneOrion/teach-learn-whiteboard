/**
 * 把一笔画到 2D 上下文上。
 *
 * 单独放一个文件，是因为它有两个调用者：
 *   · 渲染器（画到离屏画布 / 可见画布）
 *   · 将来导出图片、生成给 AI 看的截图
 *
 * 调用前调用方已经把 transform 设成 CSS 像素坐标系，所以这里全部用 CSS 坐标。
 */

import type { Point, Stroke } from './strokes';

/** 橡皮的视觉宽度倍率（橡皮要比笔粗一些才好用） */
const ERASER_SCALE = 5;

/**
 * 某个采样点处的线宽。
 *
 * ⚠️ 只有笔（pen）有真实压感。手指和鼠标的 pressure 恒为 0.5 左右，
 * 如果照样按压感算，画出来的线会莫名其妙偏细。所以非笔设备一律用固定宽度。
 */
function widthAt(s: Stroke, p: Point): number {
  const base = s.erase ? s.size * ERASER_SCALE : s.size;
  if (s.source !== 'pen') return base;
  const pressure = p.pressure > 0 ? p.pressure : 0.5;
  return base * (0.4 + 0.6 * pressure);
}

export function paintStroke(g: CanvasRenderingContext2D, s: Stroke): void {
  const pts = s.points;
  if (pts.length === 0) return;

  g.save();
  // 橡皮不是"画白色"，而是把已有像素挖掉 —— 这样将来叠在 AI 写的板面上也能擦
  g.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // 单点：点一下要留下一个圆点，而不是什么都没有
  if (pts.length === 1) {
    const first = pts[0]!;
    g.beginPath();
    g.arc(first.x, first.y, Math.max(widthAt(s, first) / 2, 0.5), 0, Math.PI * 2);
    g.fill();
    g.restore();
    return;
  }

  // 逐段绘制：每段用两端压感的平均值决定线宽，从而画出一笔里粗细变化的线条
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    g.beginPath();
    g.lineWidth = Math.max((widthAt(s, a) + widthAt(s, b)) / 2, 0.5);
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  }

  g.restore();
}
