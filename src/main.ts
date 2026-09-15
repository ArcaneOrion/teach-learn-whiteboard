/**
 * M0 入口 —— 把墨迹层的三个部件接起来
 *
 *   strokes.ts   数据（一笔长什么样）
 *   input.ts     输入（指针事件 → 一笔）
 *   renderer.ts  渲染（一笔 → 画面）
 *
 * 这个文件只做「接线」和「界面」，不含任何手写逻辑 —— 这样将来把 ink/ 换成
 * 原生低延迟视图时，这里几乎不用改。
 */

import './style.css';

import type { Stroke } from './ink/strokes';
import type { InkStyle } from './ink/input';
import { InkRenderer } from './ink/renderer';
import { attachInkInput } from './ink/input';

// ── 取元素 ────────────────────────────────────────────────────

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`找不到元素：${selector}`);
  return el;
}

const canvas = must<HTMLCanvasElement>('#ink');
const stage = must<HTMLElement>('#stage');
const hud = must<HTMLElement>('#hud');
const statusEl = must<HTMLElement>('#status');
const undoBtn = must<HTMLButtonElement>('#undo');
const clearBtn = must<HTMLButtonElement>('#clear');

// ── 状态 ──────────────────────────────────────────────────────

/**
 * 已完成的笔画。
 *
 * 现在它就是一个普通数组。到 M1，这个数组会改成「由事件日志折叠得到」——
 * 届时撤销、清空、同步都会走事件，而不是直接改数组。
 */
const strokes: Stroke[] = [];

/** 当前笔的设置 */
const style: InkStyle = { color: '#1f2328', size: 4, erase: false };

const renderer = new InkRenderer(canvas, () => strokes);

// ── 调试读数（M1 之后会去掉）─────────────────────────────────
//
// 它不是装饰。M0 要验证的核心问题全在这里：
//   · 设备：笔 / 手指 / 鼠标 —— 验证有没有拿到笔
//   · 压感：笔应该有 0~1 的变化；手指恒为 0（说明我们没把假压感当真）
//   · 采样点：一笔的点数 —— 太少说明 getCoalescedEvents 没生效
//   · DPR：验证高分屏处理，数值和手机设置对得上才算对

interface Stats {
  source: string;
  pressure: number;
  lastStrokePoints: number;
}

const stats: Stats = { source: '—', pressure: 0, lastStrokePoints: 0 };
let totalPoints = 0;
let hudScheduled = false;

function paintHud(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = stage.getBoundingClientRect();
  hud.textContent = [
    `设备 ${stats.source}`,
    `压感 ${stats.pressure.toFixed(2)}`,
    `笔画 ${strokes.length}`,
    `总采样点 ${totalPoints}`,
    `上一笔 ${stats.lastStrokePoints} 点`,
    `DPR ${dpr.toFixed(2)}`,
    `画布 ${Math.round(rect.width)}×${Math.round(rect.height)}`,
    `位图 ${canvas.width}×${canvas.height}`,
  ].join(' · ');
}

/** 一帧最多更新一次读数，避免每来一个采样点就写一次 DOM */
function scheduleHud(): void {
  if (hudScheduled) return;
  hudScheduled = true;
  requestAnimationFrame(() => {
    hudScheduled = false;
    paintHud();
  });
}

// ── 尺寸：CSS 尺寸交给布局，位图尺寸按 devicePixelRatio 放大 ──

function syncSize(): void {
  const rect = stage.getBoundingClientRect();
  renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
  scheduleHud();
}

new ResizeObserver(syncSize).observe(stage);
// 旋屏、拖动窗口跨屏（DPR 变了）时 ResizeObserver 不一定触发，这里再兜一层
window.addEventListener('resize', syncSize);
window.addEventListener('orientationchange', syncSize);

// ── 接线：输入 → 渲染 ────────────────────────────────────────

attachInkInput(
  canvas,
  {
    onBegin(stroke) {
      stats.source = stroke.source;
      stats.pressure = stroke.points[0]?.pressure ?? 0;
      renderer.begin(stroke);
      scheduleHud();
    },
    onExtend(stroke) {
      const last = stroke.points[stroke.points.length - 1];
      if (last !== undefined) stats.pressure = last.pressure;
      renderer.extend();
      scheduleHud();
    },
    onEnd(stroke) {
      strokes.push(stroke);
      totalPoints += stroke.points.length;
      stats.lastStrokePoints = stroke.points.length;
      renderer.end();
      scheduleHud();
    },
    onCancel() {
      renderer.cancelActive();
      scheduleHud();
    },
  },
  () => style,
);

// 长按画布会弹出系统菜单，打断写字
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ── 工具栏 ────────────────────────────────────────────────────

/** 一组互斥按钮：点了谁，谁亮，其它灭 */
function bindRadioGroup(selector: string, onPick: (el: HTMLElement) => void): void {
  const els = Array.from(document.querySelectorAll<HTMLElement>(selector));
  for (const el of els) {
    el.addEventListener('click', () => {
      for (const other of els) other.classList.remove('is-active');
      el.classList.add('is-active');
      onPick(el);
    });
  }
}

bindRadioGroup('[data-tool]', (el) => {
  style.erase = el.dataset['tool'] === 'eraser';
  statusEl.textContent = style.erase ? 'M0 · 墨迹层 · 橡皮' : 'M0 · 墨迹层 · 画笔';
});

bindRadioGroup('[data-color]', (el) => {
  const c = el.dataset['color'];
  if (c !== undefined) style.color = c;
});

bindRadioGroup('[data-size]', (el) => {
  const n = Number(el.dataset['size']);
  if (Number.isFinite(n) && n > 0) style.size = n;
});

undoBtn.addEventListener('click', () => {
  const removed = strokes.pop();
  if (removed === undefined) return;
  totalPoints -= removed.points.length;
  renderer.redrawAll();
  scheduleHud();
});

clearBtn.addEventListener('click', () => {
  if (strokes.length === 0) return;
  // 清空是不可逆的，问一次
  if (!window.confirm(`确定清空全部 ${strokes.length} 笔？`)) return;
  strokes.length = 0;
  totalPoints = 0;
  stats.lastStrokePoints = 0;
  renderer.redrawAll();
  scheduleHud();
});

// ── 启动 ──────────────────────────────────────────────────────

syncSize();
paintHud();
