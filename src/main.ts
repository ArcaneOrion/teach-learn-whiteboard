/**
 * 入口 —— 把各层接起来
 *
 *   core/events.ts       事件日志（唯一真相）
 *   core/board.ts        折叠：事件序列 → 板面状态
 *   core/session.ts      会话边界判定（板 ≠ 会话，两者正交）
 *   store/*              持久化（IndexedDB，测试时用内存实现）
 *   ink/*                手写：输入 → 笔画 → 画面（墨迹层）
 *   ui/contentLayer.ts   AI 写的板面内容（内容层）
 *   sanitize.ts          净化 AI 写的 HTML
 *
 * 这个文件只做「接线」和「界面」。
 *
 * ⚠️ M2 起的关键性质：事件一旦产生就**立刻落盘**，所以刷新页面 / 关掉 App
 *    再打开，板子还在。板面状态永远是「读回来的事件折叠出来的」。
 */

import './style.css';

import type { InkStyle } from './ink/input';
import type { BoardEvent } from './core/types';
import type { BoardRecord, Store } from './store/types';
import type { SessionRecord } from './core/session';

import { InkRenderer } from './ink/renderer';
import { attachInkInput } from './ink/input';
import { EventLog } from './core/events';
import { composeBoard, lastStroke, totalPoints, type BoardState } from './core/board';
import { resolveSession, sessionDuration } from './core/session';
import { ContentLayer } from './ui/contentLayer';
import { DEMO_REWRITE, demoBlock } from './ui/demoContent';
import { IndexedDbStore } from './store/indexedDbStore';
import { MemoryStore } from './store/memoryStore';
import { makeId } from './store/types';

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

// ── 不依赖存储的部分 ──────────────────────────────────────────

type Tool = 'pen' | 'eraser' | 'pan';

let tool: Tool = 'pen';
const inkStyle: InkStyle = { color: '#1f2328', size: 4, erase: false };

/** 板面状态 —— 永远是「事件序列折叠出来的」 */
let board: BoardState = composeBoard('', []);
let boardId = '';
let log: EventLog | null = null;
let store: Store | null = null;
let persistent = false;
let session: SessionRecord | null = null;
let boardRecord: BoardRecord | null = null;
let saveState: 'ok' | 'pending' | 'failed' = 'ok';

const renderer = new InkRenderer(canvas, () => board.strokes);
const content = new ContentLayer(contentEl);

/** 重新折叠并把结果同步给两层 */
function recompose(): void {
  if (log === null) return;
  board = composeBoard(boardId, log.all);
  content.render(board.blocks);
  scheduleHud();
}

// ── 调试读数 ──────────────────────────────────────────────────

interface Stats {
  source: string;
  pressure: number;
  lastStrokePoints: number;
}

const stats: Stats = { source: '—', pressure: 0, lastStrokePoints: 0 };
let hudScheduled = false;

function paintHud(): void {
  const dpr = window.devicePixelRatio || 1;
  const mins = session === null ? 0 : Math.floor(sessionDuration(session) / 60000);
  hud.textContent = [
    `存储 ${persistent ? 'IndexedDB' : '内存(不保存)'}`,
    saveState === 'failed' ? '⚠ 保存失败' : saveState === 'pending' ? '保存中…' : '已保存',
    `会话 ${session?.id.slice(-6) ?? '—'} · ${mins} 分`,
    `设备 ${stats.source}`,
    `压感 ${stats.pressure.toFixed(2)}`,
    `事件 ${log?.all.length ?? 0}`,
    `笔画 ${board.strokes.length}`,
    `板面块 ${board.blocks.length}`,
    `总采样点 ${totalPoints(board)}`,
    `DPR ${dpr.toFixed(2)}`,
  ].join(' · ');
}

function scheduleHud(): void {
  if (hudScheduled) return;
  hudScheduled = true;
  requestAnimationFrame(() => {
    hudScheduled = false;
    paintHud();
  });
}

function paintStatus(label: string): void {
  statusEl.textContent = label;
}

// ── 尺寸 ──────────────────────────────────────────────────────
//
// 墨迹层铺满整块板（不是视口）。这样笔迹坐标就是**板坐标**，
// 板往下长的时候旧笔迹不会错位 —— 这对同步很重要：存进事件日志的坐标
// 必须在所有设备上含义一致。

function syncSize(): void {
  const rect = boardEl.getBoundingClientRect();
  renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
  scheduleHud();
}

new ResizeObserver(syncSize).observe(boardEl);
window.addEventListener('resize', syncSize);
window.addEventListener('orientationchange', syncSize);

// ── 持久化：事件一产生就落盘 ──────────────────────────────────

/**
 * 会话 / 板的元数据不每条事件都写 —— 一秒内的连续书写合并成一次写入。
 * 事件本身（真正的数据）是**立刻**写的，这里省掉的只是元数据。
 */
const META_DEBOUNCE_MS = 1000;
let metaTimer: number | null = null;

async function flushMeta(): Promise<void> {
  if (store === null || session === null || boardRecord === null) return;
  if (metaTimer !== null) {
    window.clearTimeout(metaTimer);
    metaTimer = null;
  }
  try {
    await store.putSession(session);
    await store.putBoard(boardRecord);
    if (saveState === 'pending') saveState = 'ok';
  } catch (err) {
    console.error('保存会话/板信息失败：', err);
    saveState = 'failed';
  }
  scheduleHud();
}

function scheduleMetaSave(): void {
  saveState = 'pending';
  scheduleHud();
  if (metaTimer !== null) return;
  metaTimer = window.setTimeout(() => {
    metaTimer = null;
    void flushMeta();
  }, META_DEBOUNCE_MS);
}

/** 一条新事件 → 立刻写进存储 */
async function onNewEvent(event: BoardEvent): Promise<void> {
  if (store === null) return;
  try {
    await store.appendEvents([event]);
    if (saveState !== 'pending') saveState = 'ok';
  } catch (err) {
    console.error('保存事件失败：', err);
    saveState = 'failed';
  }

  if (session !== null) session.lastActive = event.createdAt;
  if (boardRecord !== null) boardRecord.updatedAt = event.createdAt;
  scheduleMetaSave();
}

// 切到后台时立刻把元数据写下去 —— 安卓随时可能杀进程
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushMeta();
});

// ── 启动 ──────────────────────────────────────────────────────

async function openStore(): Promise<void> {
  const idb = new IndexedDbStore();
  try {
    await idb.init();
    store = idb;
    persistent = true;
    return;
  } catch (err) {
    // 隐私模式、存储被禁用、被别的标签页挡住升级……都可能走到这里。
    // 退化成内存存储：功能照用，只是关掉就没了，并且在读数里明确标出来。
    console.warn('IndexedDB 不可用，这次的数据不会保存：', err);
  }
  const mem = new MemoryStore();
  await mem.init();
  store = mem;
  persistent = false;
}

async function boot(): Promise<void> {
  paintStatus('M1 · 正在读取…');

  await openStore();
  const s = store;
  if (s === null) throw new Error('存储初始化失败');

  // 设备 id 要持久化 —— 同步时靠它定序、去重
  let deviceId = await s.getMeta<string>('deviceId');
  if (deviceId === null) {
    deviceId = makeId('dev');
    await s.setMeta('deviceId', deviceId);
  }

  // 会话：续上还是新开，由那个纯函数决定
  const decision = resolveSession(Date.now(), await s.lastSession(), {
    userId: 'local',
    deviceId,
    newId: () => makeId('s'),
  });
  if (decision.closed !== null) await s.putSession(decision.closed);
  await s.putSession(decision.session);
  session = decision.session;

  // 板：M1 只有一块，取最近更新的那块
  const boards = await s.listBoards();
  let record = boards[0] ?? null;
  if (record === null) {
    const now = Date.now();
    record = {
      id: makeId('b'),
      userId: 'local',
      title: '未命名',
      createdAt: now,
      updatedAt: now,
      archived: 0,
    };
    await s.putBoard(record);
  }
  boardRecord = record;
  boardId = record.id;

  // 读回历史事件，日志接着往下走
  const existing = await s.loadEvents(record.id);
  const theLog = new EventLog(
    { boardId: record.id, sessionId: decision.session.id, deviceId },
    existing,
  );
  log = theLog;
  theLog.onAppend((e) => {
    void onNewEvent(e);
  });

  recompose();
  await onBoardReady(decision.isNew, existing.length);
}

async function onBoardReady(isNewSession: boolean, loadedCount: number): Promise<void> {
  const theLog = log;
  if (theLog === null) return;

  // 第一次打开一块空板时，放一条开板事件，板子才有标题
  if (loadedCount === 0) {
    theLog.createBoard('未命名');
  }

  // ── 接线：输入 → 事件日志 → 折叠 → 渲染 ──────────────────
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
        theLog.writeStroke(stroke);
        stats.lastStrokePoints = stroke.points.length;
        renderer.end();
        recompose();
      },
      onCancel() {
        renderer.cancelActive();
        scheduleHud();
      },
    },
    () => inkStyle,
  );

  applyTool();
  syncSize();
  paintHud();

  const restored = loadedCount > 0 ? `读回 ${loadedCount} 条历史事件` : '新板';
  paintStatus(
    `M1 · 事件日志 · ${restored}${isNewSession ? ' · 新会话' : ' · 续上次会话'}${persistent ? '' : ' · ⚠ 数据不会保存'}`,
  );
}

// 长按画布会弹出系统菜单，打断写字
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ── 工具栏 ────────────────────────────────────────────────────

function applyTool(): void {
  inkStyle.erase = tool === 'eraser';
  // 拖动模式：墨迹层不接事件，事件落到底下的滚动容器 → 原生滚动
  canvas.classList.toggle('is-panning', tool === 'pan');
}

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
  if (log === null) return;
  // 撤销 = 对「当前还看得见的最后一笔」追加一条撤销事件（不是删数组元素）
  const target = lastStroke(board);
  if (target === null) return;
  log.undoStroke(target.id);
  renderer.redrawAll();
  recompose();
});

clearBtn.addEventListener('click', () => {
  if (log === null) return;
  if (board.strokes.length === 0) return;
  if (!window.confirm(`确定清空全部 ${board.strokes.length} 笔？`)) return;
  log.clearInk();
  renderer.redrawAll();
  recompose();
});

// ── 假 AI（临时，M2 接真模型后删掉）──────────────────────────
//
// 它验证的是「AI 写板面」这条链路本身，而不是模型：
//   追加 → op:'append'　改写 → op:'set'　擦掉 → op:'remove'
//
// 接上真模型后，这三个操作由 pi-ai 的工具调用触发，下面一行都不用改。

let demoIndex = 0;

function scrollToBottom(): void {
  scroller.scrollTop = scroller.scrollHeight;
}

demoAppendBtn.addEventListener('click', () => {
  if (log === null) return;
  demoIndex += 1;
  log.aiWrite({ op: 'append', region: `讲解-${demoIndex}`, html: demoBlock(demoIndex) });
  recompose();
  scrollToBottom();
});

demoRewriteBtn.addEventListener('click', () => {
  if (log === null || demoIndex === 0) return;
  log.aiWrite({ op: 'set', region: `讲解-${demoIndex}`, html: DEMO_REWRITE });
  recompose();
  scrollToBottom();
});

demoRemoveBtn.addEventListener('click', () => {
  if (log === null || demoIndex === 0) return;
  log.aiWrite({ op: 'remove', region: `讲解-${demoIndex}` });
  demoIndex -= 1;
  recompose();
});

// ── 开发期工具 ────────────────────────────────────────────────
//
// 浏览器控制台里可以直接看事件日志，这对理解「唯一真相」很有用：
//   __whiteboard.log.all        看全部事件
//   __whiteboard.state()        看折叠出来的板面
//   __whiteboard.store          看存储实现
//   __whiteboard.reset()        清空全部数据并刷新（调试用）

declare global {
  interface Window {
    __whiteboard?: {
      log: () => EventLog | null;
      state: () => BoardState;
      store: () => Store | null;
      session: () => SessionRecord | null;
      reset: () => Promise<void>;
    };
  }
}

window.__whiteboard = {
  log: () => log,
  state: () => board,
  store: () => store,
  session: () => session,
  reset: async () => {
    await store?.clear();
    location.reload();
  },
};

// ── 走 ────────────────────────────────────────────────────────

boot().catch((err: unknown) => {
  console.error('启动失败：', err);
  paintStatus('启动失败，看看控制台');
});
