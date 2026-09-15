/**
 * 入口 —— 把各层接起来
 *
 *   core/events.ts       事件日志（唯一真相）
 *   core/board.ts        折叠：事件序列 → 板面状态
 *   ink/*                手写：输入 → 笔画 → 画面（墨迹层）
 *   ui/contentLayer.ts   AI 写的板面内容（内容层）
 *   sanitize.ts          净化 AI 写的 HTML
 *
 * 这个文件只做「接线」和「界面」。
 *
 * ⚠️ M1 的两个关键性质：
 *   ① 笔迹不再是普通数组，而是事件日志折叠出来的结果（撤销 = 追加一条事件）
 *   ② AI 写板面走的是「画布操作」：append / set / remove 三种，绝不整块重发
 */

import './style.css';

import type { InkStyle } from './ink/input';
import { InkRenderer } from './ink/renderer';
import { attachInkInput } from './ink/input';
import { EventLog } from './core/events';
import { composeBoard, lastStroke, totalPoints, type BoardState } from './core/board';
import { ContentLayer } from './ui/contentLayer';
import { DEMO_REWRITE, demoBlock } from './ui/demoContent';

// ── 取元素 ────────────────────────────────────────────────────

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`找不到元素：${selector}`);
  return el;
}

const canvas = must<HTMLCanvasElement>('#ink');
const scroller = must<HTMLElement>('#scroller');
const boardEl = must<HTMLElement>('#board');
const contentEl = must<HTMLElement>('#content');
const hud = must<HTMLElement>('#hud');
const statusEl = must<HTMLElement>('#status');
const undoBtn = must<HTMLButtonElement>('#undo');
const clearBtn = must<HTMLButtonElement>('#clear');
const demoAppendBtn = must<HTMLButtonElement>('#demo-append');
const demoRewriteBtn = must<HTMLButtonElement>('#demo-rewrite');
const demoRemoveBtn = must<HTMLButtonElement>('#demo-remove');

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

// ── 各层 ──────────────────────────────────────────────────────

type Tool = 'pen' | 'eraser' | 'pan';

let tool: Tool = 'pen';

/** 当前笔的设置。erase 由 tool 决定，所以这里不单独维护 */
const inkStyle: InkStyle = { color: '#1f2328', size: 4, erase: false };

const renderer = new InkRenderer(canvas, () => board.strokes);
const content = new ContentLayer(contentEl);

/**
 * 事件进日志之后重新折叠，并把结果同步给两层。
 *
 * 注意这里的分工：**折叠是纯逻辑**（core/board.ts），
 * 内容层只是把折叠结果「最小改动」地画出来（ui/contentLayer.ts）。
 */
function commit(): void {
  board = composeBoard(BOARD_ID, log.all);
  content.render(board.blocks);
  scheduleHud();
}

// ── 调试读数 ──────────────────────────────────────────────────
//
// 它不是装饰。M1 要验证的问题全在这里：
//   · 事件数：每画一笔 +1；撤销、清空、AI 写板也各 +1（日志只增不减）
//   · 笔画 / 板面块：折叠出来的两个结果，应该和画面对得上

interface Stats {
  source: string;
  pressure: number;
  lastStrokePoints: number;
}

const stats: Stats = { source: '—', pressure: 0, lastStrokePoints: 0 };
let hudScheduled = false;

function paintHud(): void {
  const dpr = window.devicePixelRatio || 1;
  hud.textContent = [
    `设备 ${stats.source}`,
    `压感 ${stats.pressure.toFixed(2)}`,
    `事件 ${log.all.length}`,
    `笔画 ${board.strokes.length}`,
    `板面块 ${board.blocks.length}`,
    `总采样点 ${totalPoints(board)}`,
    `上一笔 ${stats.lastStrokePoints} 点`,
    `DPR ${dpr.toFixed(2)}`,
    `板 ${canvas.width}×${canvas.height}`,
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

// ── 尺寸 ──────────────────────────────────────────────────────
//
// 墨迹层铺满整块板（不是视口）。这样笔迹的坐标就是**板坐标**，
// 板往下长的时候旧笔迹不会错位 —— 这一点对将来的同步很重要：
// 存进事件日志的坐标必须在所有设备上含义一致。

function syncSize(): void {
  const rect = boardEl.getBoundingClientRect();
  renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
  scheduleHud();
}

new ResizeObserver(syncSize).observe(boardEl);
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
      // ★ 关键一行：笔画先变成一条事件，再由事件折回板面
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
  () => inkStyle,
);

// 长按画布会弹出系统菜单，打断写字
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ── 工具栏 ────────────────────────────────────────────────────

function paintStatus(): void {
  const label = tool === 'pen' ? '画笔' : tool === 'eraser' ? '橡皮' : '拖动';
  statusEl.textContent = `M1 · 事件日志 · ${label}`;
}

function applyTool(): void {
  inkStyle.erase = tool === 'eraser';
  // 拖动模式：墨迹层不接事件，事件落到底下的滚动容器 → 原生滚动
  canvas.classList.toggle('is-panning', tool === 'pan');
  paintStatus();
}

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
  const picked = el.dataset['tool'];
  if (picked === 'pen' || picked === 'eraser' || picked === 'pan') {
    tool = picked;
    applyTool();
  }
});

bindRadioGroup('[data-color]', (el) => {
  const c = el.dataset['color'];
  if (c !== undefined) inkStyle.color = c;
});

bindRadioGroup('[data-size]', (el) => {
  const n = Number(el.dataset['size']);
  if (Number.isFinite(n) && n > 0) inkStyle.size = n;
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
  if (!window.confirm(`确定清空全部 ${board.strokes.length} 笔？`)) return;
  log.clearInk();
  renderer.redrawAll();
  commit();
});

// ── 假 AI（临时，M2 接真模型后删掉）──────────────────────────
//
// 它验证的是「AI 写板面」这条链路本身，而不是模型：
//   · 追加 → op:'append'
//   · 改写 → op:'set'（只替换那一块，其它块不重建）
//   · 擦掉 → op:'remove'
//
// 接上真模型之后，这三个操作会由 pi-ai 的工具调用（tool calling）触发，
// 到时把这里的按钮换成真实的对话入口即可，下面的代码一行都不用改。

let demoIndex = 0;

function scrollToBottom(): void {
  scroller.scrollTop = scroller.scrollHeight;
}

demoAppendBtn.addEventListener('click', () => {
  demoIndex += 1;
  log.aiWrite({ op: 'append', region: `讲解-${demoIndex}`, html: demoBlock(demoIndex) });
  commit();
  scrollToBottom();
});

demoRewriteBtn.addEventListener('click', () => {
  if (demoIndex === 0) return;
  log.aiWrite({ op: 'set', region: `讲解-${demoIndex}`, html: DEMO_REWRITE });
  commit();
  scrollToBottom();
});

demoRemoveBtn.addEventListener('click', () => {
  if (demoIndex === 0) return;
  log.aiWrite({ op: 'remove', region: `讲解-${demoIndex}` });
  demoIndex -= 1;
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

applyTool();
syncSize();
paintHud();
