/**
 * 入口 —— 把各层接起来
 *
 *   core/events.ts  事件日志（唯一真相）
 *   core/board.ts   折叠：事件序列 → 板面状态
 *   ink/*           手写：输入 → 笔画 → 画面
 *
 * 这个文件只做「接线」和「界面」。
 *
 * ⚠️ M1 的关键变化：笔迹**不再是一个普通数组**，而是事件日志折叠出来的结果。
 *    现在撤销是「追加一条撤销事件」，清空是「追加一条清空事件」——
 *    日志只增不减。同步、回放、学习记录都建立在这个性质上。
 */

import './style.css';

import type { InkStyle } from './ink/input';
import { InkRenderer } from './ink/renderer';
import { attachInkInput } from './ink/input';
import { EventLog } from './core/events';
import { composeBoard, lastStroke, totalPoints, type BoardState } from './core/board';

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

// ── 身份 ──────────────────────────────────────────────────────
//
// M1 还是内存里的：刷新页面就换一个新的。到 M4 会落进 SQLite，
// 那时 deviceId 要持久化（同步靠它定序），sessionId 按空闲阈值切分。

const BOARD_ID = 'board-1';
const SESSION_ID = `s-${Date.now().toString(36)}`;
const DEVICE_ID = `dev-${Math.random().toString(36).slice(2, 8)}`;

const log = new EventLog({ boardId: BOARD_ID, sessionId: SESSION_ID, deviceId: DEVICE_ID });
log.createBoard('未命名');

/** 板面状态 —— 永远是「事件序列折叠出来的」，不自己维护 */
let board: BoardState = composeBoard(BOARD_ID, log.all);

/** 事件进日志之后，重新折叠一次并刷新读数 */
function commit(): void {
  board = composeBoard(BOARD_ID, log.all);
  scheduleHud();
}

/** 当前笔的设置 */
const style: InkStyle = { color: '#1f2328', size: 4, erase: false };

const renderer = new InkRenderer(canvas, () => board.strokes);

// ── 调试读数 ──────────────────────────────────────────────────
//
// 它不是装饰。M1 要验证的问题全在这里：
//   · 事件数：每画一笔应该 +1；撤销、清空也各 +1（日志只增不减）
//   · 笔画：折叠出来的结果，应该和画面对得上
//   · 会话 / 设备：事件信封里的两个身份

interface Stats {
  source: string;
  pressure: number;
  lastStrokePoints: number;
}

const stats: Stats = { source: '—', pressure: 0, lastStrokePoints: 0 };
let hudScheduled = false;

function paintHud(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = stage.getBoundingClientRect();
  hud.textContent = [
    `设备 ${stats.source}`,
    `压感 ${stats.pressure.toFixed(2)}`,
    `事件 ${log.all.length}`,
    `笔画 ${board.strokes.length}`,
    `总采样点 ${totalPoints(board)}`,
    `上一笔 ${stats.lastStrokePoints} 点`,
    `DPR ${dpr.toFixed(2)}`,
    `画布 ${Math.round(rect.width)}×${Math.round(rect.height)}`,
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
// 旋屏、跨屏拖动（DPR 变了）时 ResizeObserver 不一定触发，这里再兜一层
window.addEventListener('resize', syncSize);
window.addEventListener('orientationchange', syncSize);

// ── 接线：输入 → 事件日志 → 折叠 → 渲染 ──────────────────────

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
      // ★ M1 的关键一行：笔画先变成一条事件，再由事件折回板面
      log.writeStroke(stroke);
      stats.lastStrokePoints = stroke.points.length;
      renderer.end();
      commit();
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

function paintStatus(): void {
  const tool = style.erase ? '橡皮' : '画笔';
  statusEl.textContent = `M1 · 事件日志 · ${tool}`;
}

bindRadioGroup('[data-tool]', (el) => {
  style.erase = el.dataset['tool'] === 'eraser';
  paintStatus();
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
  // 撤销 = 对「当前还看得见的最后一笔」追加一条撤销事件（不是删数组元素）
  const target = lastStroke(board);
  if (target === null) return;
  log.undoStroke(target.id);
  renderer.redrawAll();
  commit();
});

clearBtn.addEventListener('click', () => {
  if (board.strokes.length === 0) return;
  // 清空不可逆，问一次
  if (!window.confirm(`确定清空全部 ${board.strokes.length} 笔？`)) return;
  log.clearInk();
  renderer.redrawAll();
  commit();
});

// ── 开发期工具 ────────────────────────────────────────────────
//
// 在浏览器控制台里可以直接看事件日志，这对理解「唯一真相」很有用：
//   __whiteboard.log.all      看全部事件
//   __whiteboard.state()      看折叠出来的板面
//
// M1 验证完之后会去掉。

declare global {
  interface Window {
    __whiteboard?: { log: EventLog; state: () => BoardState };
  }
}

window.__whiteboard = { log, state: () => board };

// ── 启动 ──────────────────────────────────────────────────────

syncSize();
paintStatus();
paintHud();
