/**
 * 入口 —— 把各层接起来
 *
 *   core/events.ts       事件日志（唯一真相）
 *   core/board.ts        折叠：事件序列 → 板面状态
 *   core/session.ts      会话边界判定（板 ≠ 会话，两者正交）
 *   store/*              持久化（IndexedDB，测试时用内存实现）
 *   ink/*                手写：输入 → 笔画 → 画面（墨迹层）
 *   ui/contentLayer.ts   AI 写的板面内容（内容层）
 *   ai/*                 模型渠道、工具定义、对话回路
 *   sanitize.ts          净化 AI 写的 HTML
 *
 * 这个文件只做「接线」和「界面」。
 *
 * ⚠️ M2 起的关键性质：
 *   · 事件一旦产生就立刻落盘，刷新页面板子还在
 *   · 用户发话 → 模型调用工具 → 工具变成**事件** → 折叠 → 渲染
 *     全程没有任何一步绕开事件日志，所以撤销、回放、将来的同步都自动成立
 */

import './style.css';

import type { Api, Context, Model } from '@earendil-works/pi-ai';

import type { InkStyle } from './ink/input';
import type { BoardEvent } from './core/types';
import type { BoardRecord, Store } from './store/types';
import type { SessionRecord } from './core/session';
import type { ChannelConfig } from './ai/channels';

import { InkRenderer } from './ink/renderer';
import { attachInkInput } from './ink/input';
import { EventLog } from './core/events';
import { composeBoard, lastStroke, totalPoints, type BoardState } from './core/board';
import { resolveSession, sessionDuration } from './core/session';
import { ContentLayer } from './ui/contentLayer';
import { SettingsPanel } from './ui/settingsPanel';
import { blobToBase64, blobToDataUrl, rasterizeBoard } from './ui/rasterize';
import { IndexedDbStore } from './store/indexedDbStore';
import { MemoryStore } from './store/memoryStore';
import { makeId } from './store/types';

import { StoreCredentialStore } from './ai/credentials';
import { allChannels, buildRegistry, loadChannels, saveChannels, type ChannelRegistry } from './ai/channels';
import { runTurn, type ToolOutcome } from './ai/agent';
import { explainError } from './ai/errors';
import { boardTools, TOOL_ASK_USER, TOOL_BOARD_WRITE } from './ai/tools';
import { describeUserTurn, systemPrompt } from './ai/prompt';
import type { DemoChannel } from './ai/demoChannel';

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
const sayInput = must<HTMLTextAreaElement>('#say');
const sendBtn = must<HTMLButtonElement>('#send');
const lookBtn = must<HTMLButtonElement>('#look');
const pendingBar = must<HTMLElement>('#pending');
const pendingThumb = must<HTMLImageElement>('#pending-thumb');
const pendingClearBtn = must<HTMLButtonElement>('#pending-clear');
const choiceBar = must<HTMLElement>('#choicebar');
const channelSelect = must<HTMLSelectElement>('#channel');
const openSettingsBtn = must<HTMLButtonElement>('#open-settings');

// ── 状态 ──────────────────────────────────────────────────────

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

/** 模型渠道 */
const DEMO_CHANNEL_ID = 'demo';
let credentials: StoreCredentialStore | null = null;
let registry: ChannelRegistry | null = null;
let userChannels: ChannelConfig[] = [];
let demo: DemoChannel | null = null;
let activeChannelId = '';
let activeModelId = '';

/** 对话上下文（模型看到的往来消息）。板面内容不进这里 —— 那是另一条路 */
const conversation: Context = { messages: [] };
conversation.tools = boardTools;

let running = false;

/**
 * 已经拍好、等着和文字一起发出去的截图。
 *
 * 按产品文档的设计：点「让 AI 看」→ 立刻截图 → 输入条打开 → 写完点发送，
 * 截图和文字**一起**作为一条用户消息发出去（不是两条）。
 */
interface PendingSnapshot {
  attachmentId: string;
  blob: Blob;
  mime: string;
  dataUrl: string;
}

let pendingSnapshot: PendingSnapshot | null = null;

const renderer = new InkRenderer(canvas, () => board.strokes);
const content = new ContentLayer(contentEl);

/** 重新折叠并把结果同步给两层 */
function recompose(): void {
  if (log === null) return;
  board = composeBoard(boardId, log.all);
  content.render(board.blocks);
  paintChoices();
  scheduleHud();
}

// ── 调试读数 ──────────────────────────────────────────────────

interface Stats {
  source: string;
  pressure: number;
}

const stats: Stats = { source: '—', pressure: 0 };
let hudScheduled = false;

function paintHud(): void {
  const dpr = window.devicePixelRatio || 1;
  const mins = session === null ? 0 : Math.floor(sessionDuration(session) / 60000);
  hud.textContent = [
    `存储 ${persistent ? 'IndexedDB' : '内存(不保存)'}`,
    saveState === 'failed' ? '⚠ 保存失败' : saveState === 'pending' ? '保存中…' : '已保存',
    `会话 ${session?.id.slice(-6) ?? '—'} · ${mins} 分`,
    `事件 ${log?.all.length ?? 0}`,
    `笔画 ${board.strokes.length}`,
    `板面块 ${board.blocks.length}`,
    `总采样点 ${totalPoints(board)}`,
    `设备 ${stats.source}`,
    `压感 ${stats.pressure.toFixed(2)}`,
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

function setStatus(text: string): void {
  statusEl.textContent = text;
  // 状态条只有一行，长信息会被省略号截断 —— 完整内容挂在 title 上，悬停能看全。
  // 顺便把「点一下开关调试读数」这个隐藏操作也写进去，否则没人发现得了。
  statusEl.title = text === '' ? '点一下显示/隐藏调试读数' : `${text}\n（点一下显示/隐藏调试读数）`;
}

// ── 尺寸 ──────────────────────────────────────────────────────

function syncSize(): void {
  const rect = boardEl.getBoundingClientRect();
  renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
  scheduleHud();
}

new ResizeObserver(syncSize).observe(boardEl);
window.addEventListener('resize', syncSize);
window.addEventListener('orientationchange', syncSize);

// ── 持久化 ────────────────────────────────────────────────────

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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushMeta();
});

// ── 模型渠道 ──────────────────────────────────────────────────

/**
 * 只有开发模式才注册演示渠道。
 *
 * ⚠️ 这里**必须用 `import.meta.env.MODE`，不能用 `DEV` / `PROD`**。
 *
 * 踩过的坑（实测）：这个 Vite 版本里，`vite build` 出来的包里
 *   MODE = 'production'，但 DEV = true、PROD = false
 * —— 也就是 DEV/PROD 跟着 **NODE_ENV** 走，而不是跟着 mode 走。
 * 用 DEV 判断的后果：演示渠道（连同一个测试用的假模型库）会**被打进生产包**，
 * 而且每次启动都会真的去加载它。用 MODE 判断才可靠。
 */
const IS_DEV_BUILD = import.meta.env.MODE !== 'production';

async function refreshRegistry(): Promise<void> {
  if (store === null || credentials === null) return;

  userChannels = await loadChannels(store);
  registry = buildRegistry(allChannels(userChannels), credentials);

  if (IS_DEV_BUILD) {
    const mod = await import('./ai/demoChannel');
    demo = mod.createDemoChannel();
    registry.models.setProvider(demo.provider);
  }

  renderChannelSelect();
}

function channelOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];

  if (demo !== null) {
    const model = demo.getModel();
    options.push({
      value: `${DEMO_CHANNEL_ID}::${model?.id ?? 'demo'}`,
      label: '本地演示（假模型，不需要 Key）',
    });
  }

  for (const channel of allChannels(userChannels)) {
    for (const modelId of channel.modelIds) {
      const suffix = channel.unstable ? '（可能不稳定）' : '';
      options.push({ value: `${channel.id}::${modelId}`, label: `${channel.name} · ${modelId}${suffix}` });
    }
  }

  return options;
}

function renderChannelSelect(): void {
  const options = channelOptions();
  channelSelect.replaceChildren();

  if (options.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '还没有可用渠道 —— 点右边 ⚙️ 添加';
    channelSelect.append(opt);
    activeChannelId = '';
    activeModelId = '';
    updateSendEnabled();
    return;
  }

  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    channelSelect.append(opt);
  }

  // 尽量保持当前选择
  const wanted = `${activeChannelId}::${activeModelId}`;
  const keep = options.some((o) => o.value === wanted) ? wanted : (options[0]?.value ?? '');
  channelSelect.value = keep;
  applyChannelSelection(keep);
}

function applyChannelSelection(value: string): void {
  const [channelId = '', modelId = ''] = value.split('::');
  activeChannelId = channelId;
  activeModelId = modelId;
  updateSendEnabled();
}

/** 当前应该用哪个模型 */
function activeModel(): Model<Api> | null {
  if (activeChannelId === '') return null;
  if (activeChannelId === DEMO_CHANNEL_ID) return demo?.getModel() ?? null;
  return registry?.getModel(activeChannelId, activeModelId) ?? null;
}

function updateSendEnabled(): void {
  // 只要「有话说」或者「有截图」就能发 —— 用户可能只是画了个圈，不想打字
  const canSend =
    !running &&
    activeModel() !== null &&
    (sayInput.value.trim() !== '' || pendingSnapshot !== null);
  sendBtn.disabled = !canSend;
  sayInput.disabled = running;
  lookBtn.disabled = running;
}

/** 设置/清空「待发送的截图」 */
function setPending(next: PendingSnapshot | null): void {
  pendingSnapshot = next;
  if (next === null) {
    pendingBar.hidden = true;
    pendingThumb.removeAttribute('src');
  } else {
    pendingThumb.src = next.dataUrl;
    pendingBar.hidden = false;
  }
  updateSendEnabled();
}

/**
 * 「让 AI 看」—— 把板面（含用户笔迹）拍成图，存在附件表里，等着一并发送。
 *
 * 图片**立刻落盘**而不是留在内存：这样即使接下来 App 被杀掉，截图也不会丢，
 * 而且 M4 做检索时它已经在那儿了。
 */
async function captureSnapshot(): Promise<void> {
  if (running || store === null || session === null || boardId === '') return;

  lookBtn.disabled = true;
  setStatus('正在拍板面…');
  try {
    const shot = await rasterizeBoard({ board: boardEl, viewport: scroller });
    const mime = shot.blob.type === '' ? 'image/png' : shot.blob.type;
    const attachmentId = makeId('att');

    await store.putAttachment(
      {
        id: attachmentId,
        userId: 'local',
        sessionId: session.id,
        boardId,
        kind: 'snapshot',
        mime,
        bytes: shot.blob.size,
        width: shot.width,
        height: shot.height,
        caption: null, // M4 才生成图说（那是让截图能被文字搜索到的关键）
        createdAt: Date.now(),
      },
      shot.blob,
    );

    setPending({ attachmentId, blob: shot.blob, mime, dataUrl: await blobToDataUrl(shot.blob) });
    setStatus(`板面已拍好（${Math.max(1, Math.round(shot.blob.size / 1024))} KB）· 写上你想说的再发送`);
    sayInput.focus();
  } catch (err) {
    console.error('拍板面失败：', err);
    setStatus(`拍板面失败：${explainError(err, runtime())}`);
  } finally {
    lookBtn.disabled = false;
  }
}

channelSelect.addEventListener('change', () => {
  applyChannelSelection(channelSelect.value);
});

// ── 工具执行：AI 的「画布操作」落到事件日志 ────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * 执行模型发来的工具调用。
 *
 * ⚠️ 参数要**自己校验**：模型可能少给字段、给错类型。
 * 校验失败不抛异常，而是回一条 isError 的结果 —— 模型往往能自己改对，
 * 而抛异常只会让用户看到一句莫名其妙的报错（见 ai/agent.ts 的说明）。
 */
function executeTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const theLog = log;
  if (theLog === null) return { result: '板还没准备好', isError: true };

  if (name === TOOL_BOARD_WRITE) {
    const op = asString(args['op']);
    const region = asString(args['region']);
    const html = asString(args['html']);

    if (op === 'append') {
      if (html === undefined) return { result: 'op=append 时必须给 html', isError: true };
      theLog.aiWrite(region === undefined ? { op: 'append', html } : { op: 'append', html, region });
    } else if (op === 'set') {
      if (region === undefined) return { result: 'op=set 时必须给 region', isError: true };
      if (html === undefined) return { result: 'op=set 时必须给 html', isError: true };
      theLog.aiWrite({ op: 'set', region, html });
    } else if (op === 'remove') {
      if (region === undefined) return { result: 'op=remove 时必须给 region', isError: true };
      theLog.aiWrite({ op: 'remove', region });
    } else {
      return { result: `不认识的 op：${String(op)}。只能是 append / set / remove。`, isError: true };
    }

    recompose();
    scrollToBottom();

    const regions = board.blocks.map((b) => b.region ?? '（未命名）').join('、');
    return {
      result: `已经写到板上了。板上一共 ${board.blocks.length} 块，区域依次是：${regions}。`,
    };
  }

  if (name === TOOL_ASK_USER) {
    const raw = args['choices'];
    if (!Array.isArray(raw) || raw.length === 0) {
      return { result: 'choices 必须是非空数组', isError: true };
    }
    const choices = raw
      .map((c) => {
        const item = c as Record<string, unknown>;
        return { id: asString(item['id']) ?? '', label: asString(item['label']) ?? '' };
      })
      .filter((c) => c.id !== '' && c.label !== '');

    if (choices.length === 0) {
      return { result: 'choices 里每一项都要有 id 和 label', isError: true };
    }

    theLog.aiAsk(choices);
    recompose();
    return { result: '选项已经显示给用户了，等他点选。现在停下来，不要再写板。' };
  }

  return { result: `没有这个工具：${name}`, isError: true };
}

/** 我们是在安卓 App 里跑，还是在电脑浏览器里？决定报错时提不提 CORS */
function runtime(): 'browser' | 'app' {
  // Capacitor 注入 window.Capacitor。装上 Capacitor 之后这里自然为真
  return 'Capacitor' in window ? 'app' : 'browser';
}

// ── 一次对话回合 ──────────────────────────────────────────────

function scrollToBottom(): void {
  scroller.scrollTop = scroller.scrollHeight;
}

async function sendTurn(rawText: string, snapshot: PendingSnapshot | null = null): Promise<void> {
  if (running) return;
  const theLog = log;
  const model = activeModel();
  if (theLog === null || model === null) return;

  const text = rawText.trim();
  // 没打字也不算错 —— 用户可能只是画了个圈就想让 AI 看
  if (text === '' && snapshot === null) return;

  running = true;
  updateSendEnabled();
  setStatus(snapshot === null ? '正在思考…' : '正在把截图发给模型…');

  const textForModel =
    text !== ''
      ? describeUserTurn({ text, strokeCount: 0 })
      : '（用户没有打字，只发了一张板面截图 —— 留意他在上面圈了什么、写了什么）';

  // ① 先记事件。截图和文字是同一次发送，所以只记**一条**
  if (snapshot === null) {
    theLog.say(textForModel);
  } else {
    theLog.snapshot({ attachmentId: snapshot.attachmentId, text: text === '' ? null : text });
  }
  recompose();

  // ② 系统提示词每轮刷新 —— 区域列表会变，模型要知道现在能 set 哪些区域
  const regions = board.blocks.map((b) => b.region).filter((r): r is string => r !== null);
  conversation.systemPrompt = systemPrompt({ boardTitle: board.title, regions });

  // ③ 用户消息。有截图时，文字和图片放在**同一条消息**里
  try {
    if (snapshot === null) {
      conversation.messages.push({ role: 'user', content: textForModel, timestamp: Date.now() });
    } else {
      const base64 = await blobToBase64(snapshot.blob);
      conversation.messages.push({
        role: 'user',
        content: [
          { type: 'text', text: textForModel },
          { type: 'image', data: base64, mimeType: snapshot.mime },
        ],
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    console.error('准备截图失败：', err);
    setStatus(`出错：${explainError(err, runtime())}`);
    running = false;
    updateSendEnabled();
    return;
  }

  // ④ 演示渠道需要按用户输入重新装填剧本
  if (activeChannelId === DEMO_CHANNEL_ID && demo !== null) demo.arm(textForModel);

  const models = registry?.models;
  if (models === undefined) {
    running = false;
    updateSendEnabled();
    return;
  }

  try {
    const result = await runTurn({
      models,
      model,
      context: conversation,
      execute: executeTool,
      onToolCall: (name) => {
        setStatus(name === TOOL_BOARD_WRITE ? '正在写板…' : '正在出选项…');
      },
    });

    if (result.stopReason === 'toolUse') {
      setStatus(`停下了（转了 ${result.steps} 圈还没结束，可能陷入循环）`);
    } else {
      setStatus(`就绪 · 本轮 ${result.toolCalls} 次工具调用`);
    }
  } catch (err) {
    console.error('对话失败：', err);
    setStatus(`出错：${explainError(err, runtime())}`);
  } finally {
    running = false;
    updateSendEnabled();
  }
}

// ── 选项条 ────────────────────────────────────────────────────

function paintChoices(): void {
  choiceBar.replaceChildren();

  const choices = board.choices;
  if (choices === null || choices.length === 0) {
    choiceBar.hidden = true;
    return;
  }

  choiceBar.hidden = false;
  for (const choice of choices) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = choice.label;
    btn.addEventListener('click', () => {
      // 点选回流成一条**真实的用户消息**（不是隐藏的 RPC）——
      // 和教学平面的做法一致
      const theLog = log;
      if (theLog === null || running) return;
      theLog.answer(choice.id);
      recompose();
      void sendTurn(choice.label);
    });    choiceBar.append(btn);
  }
}

// 输入条
sayInput.addEventListener('keydown', (e) => {
  // 回车发送，Shift+回车换行
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
});

sayInput.addEventListener('input', () => {
  sayInput.style.height = 'auto';
  sayInput.style.height = `${Math.min(sayInput.scrollHeight, 140)}px`;
  updateSendEnabled();
});

/** 统一走这里：取出文字和待发送的截图，清空界面，然后发出去 */
function doSend(): void {
  const text = sayInput.value;
  const snapshot = pendingSnapshot;
  sayInput.value = '';
  sayInput.style.height = 'auto';
  setPending(null); // 先清空界面，截图已经被 snapshot 变量接住了
  void sendTurn(text, snapshot);
}

sendBtn.addEventListener('click', doSend);

lookBtn.addEventListener('click', () => {
  void captureSnapshot();
});

pendingClearBtn.addEventListener('click', () => {
  setPending(null);
  setStatus('已取消这张截图');
});

// ── 工具栏 ────────────────────────────────────────────────────

function applyTool(): void {
  inkStyle.erase = tool === 'eraser';
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

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ── 渠道设置面板 ──────────────────────────────────────────────

function makeSettingsPanel(): SettingsPanel {
  return new SettingsPanel(
    {
      onOpen: async () => userChannels,
      newId: () => makeId('ch'),
      onAdd: async (channel) => {
        if (store === null) return;
        userChannels = [...userChannels, channel];
        await saveChannels(store, userChannels);
        await refreshRegistry();
      },
      onRemove: async (channelId) => {
        if (store === null || credentials === null) return;
        userChannels = userChannels.filter((c) => c.id !== channelId);
        await saveChannels(store, userChannels);
        await credentials.delete(channelId);
        await refreshRegistry();
      },
    },
    async (channelId, key) => {
      await credentials?.setApiKey(channelId, key);
    },
  );
}

let settingsPanel: SettingsPanel | null = null;

openSettingsBtn.addEventListener('click', () => {
  void settingsPanel?.open();
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
    console.warn('IndexedDB 不可用，这次的数据不会保存：', err);
  }
  const mem = new MemoryStore();
  await mem.init();
  store = mem;
  persistent = false;
}

/**
 * 从事件日志里恢复一点对话上下文。
 *
 * 板面内容**不进这里** —— 模型写过的板就在板上，不需要再念一遍（那会白烧 token）。
 * 这里只把用户之前问过的话放回去，让模型知道「我们聊到哪了」。
 */
function seedConversation(theLog: EventLog): void {
  const asks: Context['messages'] = [];
  for (const e of theLog.all) {
    if (e.kind === 'user.say') {
      asks.push({ role: 'user', content: e.payload.text, timestamp: e.createdAt });
    }
  }
  conversation.messages = asks.slice(-8);
}

async function boot(): Promise<void> {
  setStatus('M2 · 正在读取…');

  await openStore();
  const s = store;
  if (s === null) throw new Error('存储初始化失败');

  let deviceId = await s.getMeta<string>('deviceId');
  if (deviceId === null) {
    deviceId = makeId('dev');
    await s.setMeta('deviceId', deviceId);
  }

  const decision = resolveSession(Date.now(), await s.lastSession(), {
    userId: 'local',
    deviceId,
    newId: () => makeId('s'),
  });
  if (decision.closed !== null) await s.putSession(decision.closed);
  await s.putSession(decision.session);
  session = decision.session;

  const boards = await s.listBoards();
  let record = boards[0] ?? null;
  if (record === null) {
    const now = Date.now();
    record = { id: makeId('b'), userId: 'local', title: '未命名', createdAt: now, updatedAt: now, archived: 0 };
    await s.putBoard(record);
  }
  boardRecord = record;
  boardId = record.id;

  const existing = await s.loadEvents(record.id);
  const theLog = new EventLog(
    { boardId: record.id, sessionId: decision.session.id, deviceId },
    existing,
  );
  log = theLog;
  theLog.onAppend((e) => {
    void onNewEvent(e);
  });

  credentials = new StoreCredentialStore(s);
  await refreshRegistry();
  seedConversation(theLog);

  recompose();
  await onBoardReady(decision.isNew, existing.length);
}

async function onBoardReady(isNewSession: boolean, loadedCount: number): Promise<void> {
  const theLog = log;
  if (theLog === null) return;

  if (loadedCount === 0) theLog.createBoard('未命名');

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
        theLog.writeStroke(stroke);
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

  settingsPanel = makeSettingsPanel();

  // 调试读数：生产构建里默认关掉（它是浮在板面上的，会挡住内容）；
  // 点状态条可以随时开关。开发模式默认开着，方便调试。
  hud.hidden = !IS_DEV_BUILD;
  statusEl.style.cursor = 'pointer';
  statusEl.addEventListener('click', () => {
    hud.hidden = !hud.hidden;
  });

  applyTool();
  syncSize();
  updateSendEnabled();
  paintHud();

  const restored = loadedCount > 0 ? `读回 ${loadedCount} 条历史事件` : '新板';
  setStatus(
    `M2 · ${restored}${isNewSession ? ' · 新会话' : ' · 续上次会话'}${persistent ? '' : ' · ⚠ 数据不会保存'}`,
  );
}

// ── 开发期工具 ────────────────────────────────────────────────

declare global {
  interface Window {
    __whiteboard?: {
      log: () => EventLog | null;
      state: () => BoardState;
      store: () => Store | null;
      session: () => SessionRecord | null;
      channels: () => { user: ChannelConfig[]; active: string };
      conversation: () => Context;
      reset: () => Promise<void>;
    };
  }
}

window.__whiteboard = {
  log: () => log,
  state: () => board,
  store: () => store,
  session: () => session,
  channels: () => ({ user: userChannels, active: `${activeChannelId}::${activeModelId}` }),
  conversation: () => conversation,
  reset: async () => {
    await store?.clear();
    location.reload();
  },
};

boot().catch((err: unknown) => {
  console.error('启动失败：', err);
  setStatus(`启动失败：${err instanceof Error ? err.message : String(err)}`);
});
