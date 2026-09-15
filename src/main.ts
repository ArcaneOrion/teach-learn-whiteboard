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
import type { BoardEvent, FeedbackRating } from './core/types';
import type { BoardRecord, Store } from './store/types';
import type { SessionRecord } from './core/session';
import type { ChannelConfig } from './ai/channels';
import type { InkInputHandle } from './ink/input';

import { InkRenderer } from './ink/renderer';
import { attachInkInput } from './ink/input';
import { EventLog } from './core/events';
import { composeBoard, lastStroke, totalPoints, type BoardState } from './core/board';
import { resolveSession, sessionDuration } from './core/session';
import { ContentLayer } from './ui/contentLayer';
import { SettingsPanel } from './ui/settingsPanel';
import { HistoryPanel } from './ui/historyPanel';
import { DataPanel } from './ui/dataPanel';
import { MaterialsPanel } from './ui/materialsPanel';
import { BoardsPanel, type BoardSummary } from './ui/boardsPanel';
import { htmlToText } from './ui/htmlText';
import { blobToBase64, blobToDataUrl } from './base64';
import { rasterizeBoard } from './ui/rasterize';
import { buildIndex, dedupeByRegion, type SearchDoc } from './core/search';
import { deriveSessionHint } from './core/history';
import { chunkText, searchMaterials, type MaterialCandidate } from './core/materials';
import { extractPdfText, looksLikePdf, pageOfOffset } from './ui/pdfText';
import { backupFileName, countCredentials, parseBackup } from './core/backup';
import { backupToBlob, exportBackup, importBackup } from './store/transfer';
import { saveBlob } from './platform/saveFile';
import { reconcileBoards, pickStartupBoard, countContentEvents } from './store/boards';
import { HttpTransport } from './sync/httpTransport';
import { runSync, type SyncResult } from './sync/syncEngine';
import { AutoSync } from './sync/autoSync';
import type { SyncConfig } from './ui/dataPanel';
import { IndexedDbStore } from './store/indexedDbStore';
import { MemoryStore } from './store/memoryStore';
import { makeId } from './store/types';

import { StoreCredentialStore } from './ai/credentials';
import { allChannels, buildRegistry, loadChannels, saveChannels, type ChannelRegistry } from './ai/channels';
import { runTurn, type ToolOutcome } from './ai/agent';
import { explainError } from './ai/errors';
import { boardTools, TOOL_ASK_USER, TOOL_BOARD_WRITE, TOOL_SEARCH_MATERIALS } from './ai/tools';
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
const openHistoryBtn = must<HTMLButtonElement>('#open-history');
const openDataBtn = must<HTMLButtonElement>('#open-data');
const openMaterialsBtn = must<HTMLButtonElement>('#open-materials');
const openBoardsBtn = must<HTMLButtonElement>('#open-boards');

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

/** 这台设备的 id。同步靠它定序，所以必须持久化 */
let deviceId = '';

/** 同步设置存在 meta 里 */
const SYNC_CONFIG_KEY = 'syncConfig';

/** 自动同步的调度器。没配服务端 / 用户关掉了就是 null */
let autoSync: AutoSync | null = null;

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
 * 当前这一轮的取消开关。
 *
 * 为什么要有它：模型可能很慢、卡住，或者开始胡言乱语 ——
 * 那时候用户**必须能停下来**，否则只能干等或者关掉 App。
 * `runTurn` 一直支持 `AbortSignal`，只是之前从来没接上。
 */
let abortController: AbortController | null = null;

/** 手写输入的句柄。长按要弹反馈时，得能把正在画的那一笔撤掉 */
let inkHandle: InkInputHandle | null = null;

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

  /**
   * 空板引导只在**一个字都没有、一笔都没画**的时候出现。
   *
   * 只判断"没有板面块"是不够的：用户可能先手写了一段，
   * 那时候引导还杵在那儿、和笔迹叠在一起，很碍事。
   */
  content.render(board.blocks, board.feedback, {
    showHint: board.blocks.length === 0 && board.strokes.length === 0,
  });

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

  // 本机有新内容了 → 让自动同步排一次（会 debounce，连着写不会每笔都发请求）
  autoSync?.notifyChange();

  if (session !== null) session.lastActive = event.createdAt;
  // ⚠️ 只有**属于当前这块板**的事件才更新 boardRecord ——
  //    否则给别的板改名时，会把当前板的"最近更新时间"也带跑偏
  if (boardRecord !== null && event.boardId === boardRecord.id) {
    boardRecord.updatedAt = event.createdAt;
  }
  scheduleMetaSave();

  // 记录面板开着的时候，新内容进来要让它能立刻搜到
  if (historyPanel?.isOpen === true) void historyPanel.reload();
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
      // 手机竖屏下拉里标签别写太长（详细说明在设置面板里）
      label: '本地演示（不用 Key）',
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
  // 运行中：按钮变成「停止」，而且**必须可点** —— 不然模型卡住时用户毫无办法
  if (running) {
    sendBtn.disabled = abortController === null;
    sendBtn.title = '停下这一轮';
    sayInput.disabled = true;
    lookBtn.disabled = true;
    return;
  }

  // 只要「有话说」或者「有截图」就能发 —— 用户可能只是画了个圈，不想打字
  const canSend =
    activeModel() !== null && (sayInput.value.trim() !== '' || pendingSnapshot !== null);
  sendBtn.disabled = !canSend;

  // 灰着的按钮得说明为什么灰着 —— 否则用户只会觉得"这 App 坏了"
  sendBtn.title = activeModel() !== null ? '' : '还不能发：先去「⚙️ 渠道」配一个模型渠道';

  sayInput.disabled = false;
  lookBtn.disabled = false;
}

/**
 * 切换「正在跑一轮」的状态。
 *
 * 按钮文案要跟着变 —— 同一个按钮在两种状态下做两件事，
 * 光靠 disable 是表达不出来的（用户会以为它只是还不能点）。
 */
function setRunning(next: boolean): void {
  running = next;
  sendBtn.textContent = next ? '⏹ 停止' : '发送';
  sendBtn.classList.toggle('btn--danger', next);
  updateSendEnabled();
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
 * 状态条上「它正在干什么」那句话。
 *
 * ⚠️ 别写成「是 board_write 就说写板、否则说出选项」那种二分 ——
 * 加了 search_materials 之后，查资料会被说成"正在出选项"。
 * 每加一个工具就得回来补一句，所以这里的 default 分支要有意义
 * （宁可显示工具名，也不要显示一句错的）。
 */
function describeTool(name: string): string {
  switch (name) {
    case TOOL_BOARD_WRITE:
      return '正在写板…';
    case TOOL_ASK_USER:
      return '正在出选项…';
    case TOOL_SEARCH_MATERIALS:
      return '正在查你的资料…';
    default:
      return `正在用 ${name}…`;
  }
}

/**
 * 执行模型发来的工具调用。
 *
 * ⚠️ 参数要**自己校验**：模型可能少给字段、给错类型。
 * 校验失败不抛异常，而是回一条 isError 的结果 —— 模型往往能自己改对，
 * 而抛异常只会让用户看到一句莫名其妙的报错（见 ai/agent.ts 的说明）。
 */
async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const theLog = log;
  if (theLog === null) return { result: '板还没准备好', isError: true };
  if (name === TOOL_SEARCH_MATERIALS) {
    const query = asString(args['query']);
    if (query === undefined || query.trim() === '') {
      return { result: 'query 必填：用一句自然语言说明你要查什么', isError: true };
    }
    return searchMaterialsTool(query);
  }

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

/**
 * 在用户上传的资料里检索，把**原文**回给模型。
 *
 * 注意返回的是原文 + 出处，不是摘要 —— 模型要能引用原话，
 * 而且它接下来应该把这段原文**写到板上**（而不是转述一遍）。
 */
async function searchMaterialsTool(query: string): Promise<ToolOutcome> {
  const theStore = store;
  if (theStore === null) return { result: '存储还没准备好', isError: true };

  const chunks = await theStore.allChunks();
  if (chunks.length === 0) {
    return {
      result: '用户还没有上传任何资料。告诉他去「📚 资料」里导入，或者先用你已有的知识回答。',
    };
  }

  const docs = await theStore.listDocs();
  const titleOf = new Map(docs.map((d) => [d.id, d.title]));

  const candidates: MaterialCandidate[] = chunks.map((c) => ({
    chunkId: c.id,
    docId: c.docId,
    docTitle: titleOf.get(c.docId) ?? '资料',
    heading: c.heading,
    text: c.text,
    page: c.page,
  }));

  const hits = searchMaterials(candidates, query, 4);

  if (hits.length === 0) {
    // 明确告诉它"没找到" —— 不然模型很可能开始编
    return {
      result: `资料里没有和「${query}」相关的段落。别硬编：直接告诉用户没找到，或者用你已有的知识回答并说明这一点。`,
    };
  }

  const body = hits
    .map((hit, i) => {
      // 出处要尽量具体：书名 + 页码 / 小节名，用户才能翻过去
      const where = [
        hit.page === null ? null : `第 ${hit.page} 页`,
        hit.heading === null ? null : hit.heading,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');
      return `【${i + 1}】出自《${hit.docTitle}》${where === '' ? '' : ` ${where}`}\n${hit.text}`;
    })
    .join('\n\n');

  setStatus(`在资料里找到了 ${hits.length} 段相关内容`);
  return {
    result: `找到 ${hits.length} 段相关内容：\n\n${body}\n\n（把要引用的原文用 board_write 写到板上，标明出自哪本书哪一节或第几页。）`,
  };
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
  abortController = new AbortController();
  const signal = abortController.signal;
  setRunning(true);
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
  const materialCount = store === null ? 0 : (await store.listDocs()).length;
  conversation.systemPrompt = systemPrompt({
    boardTitle: board.title,
    regions,
    materialCount,
  });

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
    abortController = null;
    setRunning(false);
    return;
  }

  // ④ 演示渠道需要按用户输入重新装填剧本
  if (activeChannelId === DEMO_CHANNEL_ID && demo !== null) demo.arm(textForModel);

  const models = registry?.models;
  if (models === undefined) {
    abortController = null;
    setRunning(false);
    return;
  }

  try {
    const result = await runTurn({
      models,
      model,
      context: conversation,
      execute: executeTool,
      signal,
      onToolCall: (name) => {
        // ⚠️ 别用「不是 board_write 就是出选项」这种二分 ——
        //    加了 search_materials 之后，查资料也会被说成"正在出选项"
        setStatus(describeTool(name));
      },
    });

    if (result.stopReason === 'toolUse') {
      setStatus(`停下了（转了 ${result.steps} 圈还没结束，可能陷入循环）`);
    } else {
      setStatus(`就绪 · 本轮 ${result.toolCalls} 次工具调用`);
    }
  } catch (err) {
    // 用户自己按的停止不算"出错" —— 别用红字吓他
    if (signal.aborted) {
      setStatus('已停下。板上已经写上去的内容会留着。');
    } else {
      console.error('对话失败：', err);
      setStatus(`出错：${explainError(err, runtime())}`);
    }
  } finally {
    abortController = null;
    setRunning(false);
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

  /**
   * 前面挂一句「选一个」。
   *
   * 曾经这里只有一排光秃秃的按钮 —— 万一模型忘了先把问题写到板上，
   * 用户看到的就是三个不知所谓的按钮。加一句话很便宜，同一行不额外占高度。
   */
  const hint = document.createElement('span');
  hint.className = 'choicebar__hint';
  hint.textContent = '选一个';
  choiceBar.append(hint);

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
/**
 * 手机上开始打字时，让工具栏先让位。
 *
 * 键盘弹起会把可视高度压掉一半，而工具栏一直占着 171px ——
 * 实测视口 360px 时板面只剩 92px，基本看不到上下文。
 * 那一刻用户是在打字、不是画画，工具条是纯粹的浪费。
 *
 * 样式那边用 `@media (max-width: 480px)` 兜着，宽屏上不会动工具栏。
 * （点板面会让输入框失焦 → 工具栏自动回来，所以想画画随时能画。）
 *
 * ⚠️ 验证边界：自动化环境里 `document.hasFocus()` 是 false，
 * `focus()` 只设 activeElement、**不投递焦点事件** —— 所以这一条
 * 只能用**手动派发 FocusEvent** 来验（验过：类加得上、工具栏确实隐藏）。
 * 真机上手指点一下就会触发，但「真机手感」得你自己确认。
 */
sayInput.addEventListener('focus', () => {
  document.body.classList.add('is-typing');
});

sayInput.addEventListener('blur', () => {
  document.body.classList.remove('is-typing');
});

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
  // 一轮还没跑完就别再发 —— 否则输入条里的话会被清掉，却什么也没做
  if (running) return;
  const text = sayInput.value;
  const snapshot = pendingSnapshot;
  sayInput.value = '';
  sayInput.style.height = 'auto';
  setPending(null); // 先清空界面，截图已经被 snapshot 变量接住了
  void sendTurn(text, snapshot);
}

sendBtn.addEventListener('click', () => {
  // 同一个按钮两个作用：没在跑就发送，在跑就停下
  if (running) {
    abortController?.abort();
    setStatus('正在停下…');
    return;
  }
  doSend();
});

lookBtn.addEventListener('click', () => {
  void captureSnapshot();
});

pendingClearBtn.addEventListener('click', () => {
  setPending(null);
  setStatus('已取消这张截图');
});

// ── 长按 AI 写的一块 → 给反馈 ────────────────────────────────
//
// 产品文档的取舍：**一个手势就能给** —— 长按弹出三个按钮，不要弹窗、不要填表。
//
// 难点：墨迹层（canvas）盖在内容层上面，指针事件全被它接走了，
// 所以要先临时关掉它的 pointer-events，用 elementFromPoint「看穿」它找到下面的块。
// （教学平面的 forwardClick 用的是同一招，只是方向相反。）

const LONG_PRESS_MS = 600;
/** 手指挪动超过这么多像素就不算长按（那是在画线） */
const LONG_PRESS_MOVE_PX = 8;

let pressTimer: number | null = null;
let pressOrigin: { x: number; y: number } | null = null;

function cancelPress(): void {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer);
    pressTimer = null;
  }
  pressOrigin = null;
}

function hideFeedbackMenu(): void {
  document.querySelector('#feedback-menu')?.remove();
}

/**
 * 找出某个视口坐标落在哪个板面块上。
 *
 * ⚠️ 这里**不能用 `document.elementFromPoint`**，踩过这个坑：
 *   内容层为了把指针事件让给上面的墨迹层，设了 `pointer-events: none`；
 *   而 `elementFromPoint` **会跳过 `pointer-events: none` 的元素** ——
 *   所以它永远看不到那些块，只会返回底下的 .board。
 *   （教学平面的做法是"临时把上层关掉再穿透"，但它那里的内容层本身是可点中的。）
 *
 * 几何判定反而更直接：块是纵向堆叠的、互不重叠，比一下矩形就够了。
 */
function blockAt(clientX: number, clientY: number): HTMLElement | null {
  const blocks = contentEl.querySelectorAll<HTMLElement>('.block');
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return el;
    }
  }
  return null;
}

/**
 * 长按期间屏幕上已经落下了一个点 —— 先把它撤掉，
 * 否则「长按给反馈」会顺手在板上点一个墨点。
 */
function openFeedbackAt(clientX: number, clientY: number): void {
  inkHandle?.abort();

  const block = blockAt(clientX, clientY);
  const sourceEventId = block?.dataset['sourceEvent'];

  if (block === null || sourceEventId === undefined) {
    setStatus('长按可以对 AI 写的内容表态 —— 这次长按的位置上没有 AI 写的内容');
    return;
  }
  showFeedbackMenu(clientX, clientY, sourceEventId);
}

function showFeedbackMenu(clientX: number, clientY: number, sourceEventId: string): void {
  hideFeedbackMenu();

  const menu = document.createElement('div');
  menu.className = 'feedback-menu';
  menu.id = 'feedback-menu';

  const hint = document.createElement('div');
  hint.className = 'feedback-menu__hint';
  hint.textContent = '这一条讲得怎么样？';
  menu.append(hint);

  const options: { rating: FeedbackRating; icon: string; label: string }[] = [
    { rating: 'useful', icon: '👍', label: '有用' },
    { rating: 'useless', icon: '👎', label: '没用' },
    { rating: 'wrong', icon: '❌', label: '讲错了' },
  ];

  for (const option of options) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = `${option.icon} ${option.label}`;
    btn.addEventListener('click', () => {
      log?.giveFeedback(sourceEventId, option.rating);
      hideFeedbackMenu();
      recompose();
      setStatus(`已记下：这条「${option.label}」。将来记忆系统会用到它。`);
    });
    menu.append(btn);
  }

  // 贴着按下的位置弹，但不超出屏幕
  const WIDTH = 220;
  const HEIGHT = 132;
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - WIDTH - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY + 10, window.innerHeight - HEIGHT))}px`;
  document.body.append(menu);
}

// 点别处或按 Esc 就收起来
document.addEventListener('pointerdown', (e) => {
  const menu = document.querySelector('#feedback-menu');
  if (menu !== null && !menu.contains(e.target as Node)) hideFeedbackMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideFeedbackMenu();
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

/**
 * 「清空」的两步确认。
 *
 * ⚠️ 原来这里用的是 `window.confirm`。两个问题：
 *   ① **它会阻塞浏览器自动化** —— 我自己验不了这个按钮（数据面板当初就是
 *      因为这个才改成两步确认的，这里漏了）
 *   ② 和 App 里其它破坏性操作不一致（面板里都是两步确认），
 *      而且原生弹窗在手机上盖住界面、样式也不受控
 *
 * 清空笔迹是不可撤销的（`ink.clear` 是事件，但笔迹本身找不回来），
 * 所以该拦一下 —— 只是不用原生弹窗拦。
 */
let clearArmed = false;
let clearTimer: number | null = null;

function disarmClear(): void {
  clearArmed = false;
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }
  clearBtn.textContent = '🗑 清空';
  clearBtn.classList.remove('btn--danger');
}

clearBtn.addEventListener('click', () => {
  if (log === null) return;
  if (board.strokes.length === 0) return;

  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = `再点一次，清空 ${String(board.strokes.length)} 笔`;
    clearBtn.classList.add('btn--danger');
    // 4 秒没动静就自动撤销"上膛"，免得过一会儿误点
    clearTimer = window.setTimeout(disarmClear, 4000);
    return;
  }

  disarmClear();
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
let historyPanel: HistoryPanel | null = null;
let dataPanel: DataPanel | null = null;

// ── 数据与备份 ────────────────────────────────────────────────

const APP_VERSION = '0.1.0';

function makeDataPanel(theStore: Store): DataPanel {
  return new DataPanel({
    stats: async () => {
      const boards = await theStore.listBoards();
      let events = 0;
      let attachments = 0;
      for (const b of boards) {
        events += (await theStore.loadEvents(b.id)).length;
        attachments += (await theStore.listAttachments(b.id)).length;
      }
      const meta = await theStore.allMeta();
      return {
        boards: boards.length,
        sessions: (await theStore.listSessions()).length,
        events,
        attachments,
        attachmentBytes: await theStore.attachmentBytes(),
        credentials: countCredentials(meta),
      };
    },

    onExport: async () => {
      const backup = await exportBackup(theStore, APP_VERSION, Date.now());
      const hint = await saveBlob(backupToBlob(backup), backupFileName(backup.exportedAt));

      if (hint === null) {
        setStatus('已取消导出。');
        return null;
      }

      setStatus(
        `已导出备份：${backup.data.events.length} 条事件 · ${backup.data.attachments.length} 张截图`,
      );
      return hint;
    },

    parse: (text) => parseBackup(text),

    onImport: async (backup) => {
      const summary = await importBackup(theStore, backup);

      // 导入之后必须重新读一遍 —— 内存里的日志已经不完整了
      window.setTimeout(() => location.reload(), 1200);
      return (
        `已合并：${summary.boards} 块板 · ${summary.sessions} 次会话 · ` +
        `${summary.events} 条事件 · ${summary.attachments} 张截图。正在重新载入…`
      );
    },

    onReset: async () => {
      await theStore.clear();
      location.reload();
    },

    /**
     * 把当前这块板存成一张 PNG。
     *
     * 走的是和「让 AI 看」同一套 rasterize —— 那条路已经踩平了三个坑
     * （CSS 要 CDATA、canvas 要换成位图、生产构建里 CSS 是外链），
     * 没必要再写第二套截图逻辑。
     *
     * 唯一不一样的是**拍多高**：板面底部有 45vh 的留白（给用户在最下面继续写字用），
     * 全拍下来图的下半张全是空白。但**不能去改板面布局**来裁掉它 ——
     * 用户完全可能就在那片留白上写了东西，那样就丢了。
     * 所以这里只是算一个高度告诉截图，板面一动不动。
     */
    onExportImage: async () => {
      if (boardRecord === null) return '板还没准备好。';

      const boardTop = boardEl.getBoundingClientRect().top;

      // 内容和笔迹的**真实下边界**（取两者更靠下的那个）
      let bottom = 0;
      for (const child of contentEl.children) {
        bottom = Math.max(bottom, child.getBoundingClientRect().bottom - boardTop);
      }
      for (const stroke of board.strokes) {
        for (const point of stroke.points) bottom = Math.max(bottom, point.y);
      }
      // 留一点边距，别让最后一行贴着图的边缘
      const height = Math.max(200, Math.ceil(bottom + 40));

      const shot = await rasterizeBoard({
        board: boardEl,
        viewport: scroller,
        full: true,
        height,
        // 导出可以比"给模型看"清晰得多 —— 用户要存下来、要能看清小字
        maxPixels: 12_000_000,
      });

      const safeTitle = boardRecord.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 40);
      const stamp = new Date().toLocaleDateString('sv-SE'); // sv-SE 刚好是 YYYY-MM-DD
      const hint = await saveBlob(shot.blob, `${safeTitle}-${stamp}.png`);

      if (hint === null) return '已取消，没有保存。';

      const kb = Math.round(shot.blob.size / 1024);
      return `已存成图片：${shot.width}×${shot.height}，${kb} KB。${hint}`;
    },

    // ── 同步 ──────────────────────────────────────────────────
    loadSyncConfig: async () => {
      const saved = await theStore.getMeta<SyncConfig>(SYNC_CONFIG_KEY);
      return saved ?? { baseUrl: '', token: '' };
    },

    saveSyncConfig: async (config) => {
      await theStore.setMeta(SYNC_CONFIG_KEY, config);
      applyAutoSync(config);
    },

    autoSyncStatus: () => describeAutoSync(),

    onSync: async (config) => {
      if (deviceId === '') return '这台设备还没有 id，稍后再试。';
      const result = await syncOnce(theStore, config);
      return describeSyncResult(result);
    },
  });
}

// ── 同步：手动 + 自动 ─────────────────────────────────────────

/** 跑一次同步（手动和自动走的是同一条路） */
async function syncOnce(theStore: Store, config: SyncConfig): Promise<SyncResult> {
  const transport = new HttpTransport({
    baseUrl: config.baseUrl,
    ...(config.token === '' ? {} : { token: config.token }),
  });
  return runSync({ store: theStore, transport, deviceId });
}

function describeSyncResult(result: SyncResult): string {
  const parts = [`推上去 ${result.pushed} 条`];
  if (result.merged > 0) parts.push(`拉回来 ${result.merged} 条新的`);
  else parts.push('没有新的要拉回来');
  if (result.boardsAdded > 0) parts.push(`多出 ${result.boardsAdded} 块板`);
  return `同步完成：${parts.join('，')}。`;
}

/**
 * 同步完之后，把当前这块板的视图刷成最新的。
 *
 * ⚠️ 这里**不能重载页面**（原来的手动同步就是重载的）：
 * 自动同步在后台跑，用户可能正在写字或者读一半 ——
 * 把整个页面刷掉是绝对不能接受的。改成就地重画。
 *
 * 但**不动对话上下文**：那会莫名其妙地把用户正在进行的对话清空。
 * 系统提示词每一轮都会按最新的板面重新生成，所以模型不会看到过时的板面。
 */
async function refreshBoardInPlace(): Promise<void> {
  const theStore = store;
  if (theStore === null || boardId === '' || log === null) return;

  const events = await theStore.loadEvents(boardId);
  if (events.length === log.all.length) return; // 没变化，别白重画

  log = makeLogFor(boardId, events);
  recompose();
  renderer.redrawAll();
}

/** 给用户看的自动同步状态 */
function describeAutoSync(): string {
  const last = autoSync?.lastSyncAt ?? null;
  if (!autoSync?.isRunning) return '自动同步关着 —— 只能自己点「立即同步」。';
  if (last === null) return '自动同步开着，还没成功同步过。';
  return `自动同步开着 · 上次成功：${describeLastSync(last)}`;
}

function describeLastSync(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  return `${String(Math.floor(hours / 24))} 天前`;
}

/**
 * 按配置开/关自动同步。
 *
 * 没填地址 → 不开；用户关掉了 → 不开。其它情况开着。
 */
function applyAutoSync(config: SyncConfig): void {
  const shouldRun = config.baseUrl.trim() !== '' && (config.auto ?? true);

  if (!shouldRun) {
    autoSync?.stop();
    autoSync = null;
    return;
  }

  if (autoSync !== null && autoSync.isRunning) return; // 已经在跑，别重装

  const theStore = store;
  if (theStore === null) return;

  autoSync = new AutoSync({
    sync: async () => {
      const result = await syncOnce(theStore, config);
      if (result.merged > 0) await refreshBoardInPlace();
      return { pushed: result.pushed, pulled: result.pulled, merged: result.merged };
    },
    // 失败安静处理 —— 离线是常态，不该弹错，也不该把自动同步关掉
    onError: (err) => {
      console.warn('自动同步失败（下次还会试）：', err);
    },
    shouldContinueAfterError: (err) => {
      // 口令不对 / 地址不对这种是配置问题，重试一万次也没用
      const message = err instanceof Error ? err.message : String(err);
      const permanent = /401|403|只能用英文字母/.test(message);
      if (permanent) {
        setStatus(`自动同步已停：${message}`);
        return false;
      }
      return true;
    },
  });

  autoSync.start();
  void autoSync.runNow('启动');
}

openHistoryBtn.addEventListener('click', () => {
  void historyPanel?.open();
});

/**
 * 把事件日志投影成可搜索的文档表。
 *
 * 每次打开面板时重建 —— 几千条事件重建是毫秒级的，比维护增量索引简单得多，
 * 而且永远和板上真实内容一致（不会出现"索引里有、板上没有"的鬼影）。
 */
/**
 * 建检索索引 —— **跨全部板**。
 *
 * ## 为什么不是只索引当前板
 *
 * 原来是 `buildIndex({ boardId, boardTitle, events: log.all })`，
 * 只看当前这块板。但产品文档 §9.5 写的是「你搜『一元二次』，
 * 就把**所有**含这五个字的内容列出来」。
 *
 * 而「板 = 主题」意味着用户会攒很多块板（这正是这个 App 鼓励的用法）。
 * 只搜当前板的话，攒了三十块板之后**搜什么都找不到**（除非你正好站在对的那块板上）——
 * 那就把「学了找不回来」这个核心痛点原样留着没解决。
 *
 * 实现上按板分组再各自建索引（`buildIndex` 是单板接口），
 * 这样是 O(事件数) 而不是「每块板都把所有事件扫一遍」。
 */
async function buildSearchIndex(): Promise<SearchDoc[]> {
  const theStore = store;
  if (theStore === null) return [];

  const [events, boards] = await Promise.all([theStore.allEvents(), theStore.listBoards()]);

  const byBoard = new Map<string, BoardEvent[]>();
  for (const e of events) {
    const list = byBoard.get(e.boardId);
    if (list === undefined) byBoard.set(e.boardId, [e]);
    else list.push(e);
  }

  const out: SearchDoc[] = [];
  for (const board of boards) {
    const list = byBoard.get(board.id);
    if (list === undefined || list.length === 0) continue;
    out.push(
      ...buildIndex({
        boardId: board.id,
        boardTitle: board.title,
        events: list,
        toText: htmlToText,
      }),
    );
  }
  return dedupeByRegion(out);
}

/** 点了搜索结果 → 把板面滚到对应的块，并闪一下让人看见找到了哪儿 */
async function locateOnBoard(doc: SearchDoc): Promise<void> {
  /**
   * ★ 检索是跨全部板的，所以点一条别的板上的结果时**要先切过去**。
   *
   * 不切的话，用户点了结果只会看到「这一块在板上已经不在了」——
   * 而它其实好好的，只是在另一块板上。
   */
  if (doc.boardId !== boardId) {
    await switchBoard(doc.boardId);
    // 换板之后内容层要重排完才找得到那一块
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }

  if (doc.kind !== 'ai.write' || doc.region === null) {
    // 不是板面块（比如截图、"你说的"）—— 切过去就够了
    if (doc.kind !== 'ai.write') setStatus(`在「${doc.boardTitle}」上`);
    return;
  }

  // 用 dataset 逐块比对，而不是拼 CSS 选择器 —— 区域名里可能有引号之类的字符
  const key = `r:${doc.region}`;
  const target = [...contentEl.querySelectorAll<HTMLElement>('.block')].find(
    (el) => el.dataset['blockKey'] === key,
  );
  if (target === undefined) {
    setStatus(`「${doc.region}」这一块在板上已经不在了（可能被改写过）`);
    return;
  }

  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.remove('is-located');
  // 强制重排一次，否则连续点同一条时动画不会重播
  void target.offsetWidth;
  target.classList.add('is-located');
  window.setTimeout(() => target.classList.remove('is-located'), 3000);
}

/** 已经给用户提示过「要配渠道」了吗 */
const ONBOARDED_KEY = 'channelOnboardingShown';

/**
 * 首次使用引导：一个渠道都没有时，把用户送到渠道设置面板前。
 *
 * ## 为什么这个必须做
 *
 * 生产构建里**一个内置渠道都没有**（演示渠道只在开发模式注册）。
 * 于是新装的应用：发送按钮是灰的、AI 完全不工作，而用户完全不知道为什么 ——
 * 这正是"装上去打不开、不知道从哪开始"的那类第一印象。
 *
 * 只提示一次，之后不再打扰（用户可能就是想先配好再说，或者根本不打算配）。
 */
async function guideChannelSetup(): Promise<void> {
  const theStore = store;
  if (theStore === null || settingsPanel === null) return;
  if (channelOptions().length > 0) return;

  const alreadyShown = await theStore.getMeta<boolean>(ONBOARDED_KEY);
  if (alreadyShown === true) {
    setStatus('还没有可用的模型渠道 —— 点「⚙️ 渠道」配一个，AI 才能写板');
    return;
  }
  await theStore.setMeta(ONBOARDED_KEY, true);

  setStatus('先配一个模型渠道 —— 不然 AI 没法写板。白板、手写、资料这些照常用。');
  await settingsPanel.open();
}

openSettingsBtn.addEventListener('click', () => {
  void settingsPanel?.open();
});

openDataBtn.addEventListener('click', () => {
  void dataPanel?.open();
});

// ── 资料（M7 / RAG）──────────────────────────────────────────

let materialsPanel: MaterialsPanel | null = null;

function makeMaterialsPanel(theStore: Store): MaterialsPanel {
  return new MaterialsPanel({
    list: () => theStore.listDocs(),

    import: async (file) => {
      if (looksLikePdf(file)) return importPdf(theStore, file);

      // 纯文本
      const text = await file.text();
      if (text.trim() === '') {
        return `${file.name} 是空的，或者不是纯文本。扫描版 PDF 也读不出文字（那是图片）。`;
      }
      return importPlainText(theStore, file, text);
    },

    remove: async (docId) => {
      await theStore.deleteDoc(docId);
    },
  });
}

openMaterialsBtn.addEventListener('click', () => {
  void materialsPanel?.open();
});

/**
 * 把一份文本存成资料：切块 + 入库。
 *
 * @param pageOf 可选的「字符偏移 → 页码」，PDF 才有
 */
async function importPlainText(
  theStore: Store,
  file: File,
  text: string,
  title?: string,
  pageOf?: (offset: number) => number,
): Promise<string> {
  const drafts = chunkText(text);
  if (drafts.length === 0) return '这个文件里没有可用的文字内容。';

  const docId = makeId('doc');
  const docTitle = title ?? file.name.replace(/\.[^.]+$/, '');

  await theStore.putDoc({
    id: docId,
    userId: 'local',
    title: docTitle,
    fileName: file.name,
    mime: file.type === '' ? 'text/plain' : file.type,
    chars: text.length,
    chunkCount: drafts.length,
    importedAt: Date.now(),
  });

  await theStore.putChunks(
    docId,
    drafts.map((draft, i) => ({
      id: `${docId}-${i}`,
      docId,
      ord: i,
      heading: draft.heading,
      text: draft.text,
      start: draft.start,
      end: draft.end,
      page: pageOf === undefined ? null : pageOf(draft.start),
    })),
  );

  return `已导入《${docTitle}》：${text.length} 字，切成 ${drafts.length} 块。现在问 AI 时它会自己去查。`;
}

/** 导入 PDF：抽文字（按需加载 pdf.js）→ 切块 → 入库，并且**记住每块在第几页** */
async function importPdf(theStore: Store, file: File): Promise<string> {
  setStatus('正在读 PDF…（第一次会先下载解析库，稍等）');

  const extracted = await extractPdfText(file, {
    onProgress: (done, total) => {
      setStatus(`正在读 PDF… 第 ${done}/${total} 页`);
    },
  });

  if (extracted.text.trim() === '') {
    return (
      `${file.name} 里没有抽到文字。多半是**扫描版**（整页是图片，没有文字层）—— ` +
      '这种得走视觉识别，现在还没做。'
    );
  }

  const title = file.name.replace(/\.[^.]+$/, '');
  const message = await importPlainText(theStore, file, extracted.text, title, (offset) =>
    pageOfOffset(extracted.pageStarts, offset),
  );

  return `${message.replace('已导入', `已导入（共 ${extracted.pages} 页）`)}`.replace(
    '现在问 AI 时它会自己去查。',
    '引用时会标出页码。',
  );
}

// ── 板列表：多块板之间切换 ────────────────────────────────────

let boardsPanel: BoardsPanel | null = null;

/**
 * 给某块板建一个事件日志。
 *
 * ⚠️ `sessionId` 用的是**当前会话**，不是新建一个 ——
 * 这就是「板 ≠ 会话」的落地：同一次学习里可以翻好几块板。
 */
function makeLogFor(id: string, events: readonly BoardEvent[]): EventLog {
  const theLog = new EventLog(
    { boardId: id, sessionId: session?.id ?? '', deviceId },
    events,
  );
  theLog.onAppend((e) => {
    void onNewEvent(e);
  });
  return theLog;
}

/** 切到另一块板。会话不变。 */
async function switchBoard(nextId: string): Promise<void> {
  const theStore = store;
  if (theStore === null || nextId === boardId) return;

  const next = await theStore.getBoard(nextId);
  if (next === null) return;

  boardId = nextId;
  boardRecord = next;
  log = makeLogFor(nextId, await theStore.loadEvents(nextId));

  // 对话上下文是「这块板上的往来」，换板就得重来
  conversation.messages = [];
  seedConversation(log);

  // 「清空」的"上膛"状态不跨板带着走 —— 在 A 板点了第一次、切到 B 板随手一点，
  // 不该把 B 板清掉
  disarmClear();

  recompose();
  renderer.redrawAll();

  const content = countContentEvents(log.all);
  setStatus(`切到「${next.title}」${content === 0 ? '（还是空的）' : ` · ${content} 处内容`}`);
}

function makeBoardsPanel(theStore: Store): BoardsPanel {
  const summaries = async (): Promise<BoardSummary[]> => {
    const boards = await theStore.listBoards();
    const out: BoardSummary[] = [];
    for (const board of boards) {
      out.push({
        board,
        contentCount: countContentEvents(await theStore.loadEvents(board.id)),
        isCurrent: board.id === boardId,
      });
    }
    return out;
  };

  return new BoardsPanel({
    list: summaries,

    onSwitch: async (id) => {
      await switchBoard(id);
    },

    onCreate: async (title) => {
      const now = Date.now();
      const id = makeId('b');
      await theStore.putBoard({
        id, userId: 'local', title, createdAt: now, updatedAt: now, archived: 0,
      });
      await switchBoard(id);
      // 写一条 board.create，这块板才有名字和出生时间
      log?.createBoard(title);
      recompose();
    },

    onRename: async (id, title) => {
      if (id === boardId && log !== null) {
        // 当前这块：走正常的事件通路
        log.renameBoard(title);
        if (boardRecord !== null) {
          boardRecord.title = title;
          await theStore.putBoard(boardRecord);
        }
        recompose();
        return;
      }

      // 别的板：建一个临时日志把重命名事件追加进去（onAppend 会负责落盘）
      const record = await theStore.getBoard(id);
      if (record === null) return;
      const temp = makeLogFor(id, await theStore.loadEvents(id));
      const event = temp.renameBoard(title);
      await theStore.putBoard({ ...record, title, updatedAt: event.createdAt });
    },

    onDelete: async (id) => {
      await theStore.deleteBoard(id);
      // 删掉的正好是当前这块 → 换一块有内容的，没有就新建
      if (id === boardId) {
        const rest = await theStore.listBoards();
        const counts = new Map<string, number>();
        for (const b of rest) counts.set(b.id, countContentEvents(await theStore.loadEvents(b.id)));
        const next = pickStartupBoard(rest, (bid) => counts.get(bid) ?? 0);

        if (next === null) {
          const now = Date.now();
          const freshId = makeId('b');
          await theStore.putBoard({
            id: freshId, userId: 'local', title: '未命名', createdAt: now, updatedAt: now, archived: 0,
          });
          boardId = '';
          await switchBoard(freshId);
          log?.createBoard('未命名');
          recompose();
        } else {
          boardId = '';
          await switchBoard(next.id);
        }
      }
    },
  });
}

openBoardsBtn.addEventListener('click', () => {
  void boardsPanel?.open();
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
  setStatus('正在读取…');

  await openStore();
  const s = store;
  if (s === null) throw new Error('存储初始化失败');

  const stored = await s.getMeta<string>('deviceId');
  if (stored === null) {
    deviceId = makeId('dev');
    await s.setMeta('deviceId', deviceId);
  } else {
    deviceId = stored;
  }

  const decision = resolveSession(Date.now(), await s.lastSession(), {
    userId: 'local',
    deviceId,
    newId: () => makeId('s'),
  });
  if (decision.closed !== null) await s.putSession(decision.closed);
  await s.putSession(decision.session);
  session = decision.session;

  // 先把「有哪些板」跟事件日志对一遍 —— 同步或导入拉回来的板，
  // 本机的 boards 表里可能还没有记录，那样它在界面上永远不出现
  await reconcileBoards(s);

  // ★ 选板的规则：优先选**有实质内容**的板（见 store/boards.ts 的说明）。
  //   不然同步把数据拉回来之后，用户看到的会是一块刚建的空板 ——
  //   因为新建的板立刻有一条 board.create，updatedAt 永远是最新的。
  const boards = await s.listBoards();
  const counts = new Map<string, number>();
  for (const candidate of boards) {
    counts.set(candidate.id, countContentEvents(await s.loadEvents(candidate.id)));
  }

  let record = pickStartupBoard(boards, (id) => counts.get(id) ?? 0);
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

  /**
   * ★★ 启动时必须**手动重画一次墨迹层**。
   *
   * 踩过的坑（「一刷新手写就不见了」）：`renderer` 只在 `resize()` 里重建离屏画布，
   * 而 `resize()` **只在位图尺寸变化时**才重建（那个判断是为了省性能）。
   *
   * 启动顺序恰好卡在这个缝里：
   *   ① canvas 先按版式定尺寸 —— 此时事件还没加载，笔迹是空的
   *   ② 再读回历史事件、`recompose()` —— 它只管内容层（AI 写的 HTML）
   *   ③ 没有任何人再叫墨迹层重画
   *
   * 于是**重载之后板上的手写全是空的**（数据其实好好的，事件都在）——
   * 而且再画一笔只会画出那一笔，看起来像"旧笔迹丢了"。
   *
   * 换板那条路（`switchBoard`）一直是 `recompose(); renderer.redrawAll();` 成对出现的，
   * 所以切板是好的 —— **只有启动这条路漏了**。
   */
  renderer.redrawAll();

  await onBoardReady(decision.isNew, existing.length);
}

async function onBoardReady(isNewSession: boolean, loadedCount: number): Promise<void> {
  const theLog = log;
  if (theLog === null) return;

  if (loadedCount === 0) theLog.createBoard('未命名');

  inkHandle = attachInkInput(
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
        /**
         * ⚠️⚠️ 这里**必须**读模块级的 `log`，不能用上面那个 `theLog` 常量。
         *
         * 踩过的坑（数据完整性级别）：
         * 这个回调是**长期存活**的 —— 它挂在 canvas 上，一直用到 App 关掉为止。
         * 而 `theLog` 是 `onBoardReady` 开头捕获的**那一刻**的日志。
         * 于是：**切换板之后，所有手写笔迹都还写进上一块板**。
         *
         * 症状极具欺骗性：画的时候一切正常（渲染器在本机把线画出来了），
         * **一刷新就发现笔迹跑到了别的板上**、当前板上什么都没有。
         *
         * 教训：长期存活的回调里，**不要捕获会变的东西**。
         * 同一个函数里另外几处 `const theLog = log`（executeTool / sendTurn /
         * paintChoices）是每次调用现取的，没问题 —— 差别就在"活多久"。
         */
        log?.writeStroke(stroke);
        renderer.end();
        recompose();
      },
      onCancel() {
        renderer.cancelActive();
        // 一笔被丢弃通常意味着"用户改成别的手势了"（两指拖动、笔接管手掌）
        // —— 长按计时也该跟着取消，不然会莫名弹出反馈菜单
        cancelPress();
        scheduleHud();
      },
      // 两指拖动 → 滚板面。方向和手指一致（往下拖 = 往回看）
      onPan: (dx, dy) => {
        scroller.scrollTop -= dy;
        scroller.scrollLeft -= dx;
      },
    },
    () => inkStyle,
  );

  // 长按检测。放在 attachInkInput 之后 —— 两者互不干扰，但顺序清楚了更好读
  canvas.addEventListener('pointerdown', (e) => {
    if (tool === 'pan') return;
    cancelPress();
    pressOrigin = { x: e.clientX, y: e.clientY };
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      const at = pressOrigin;
      pressOrigin = null;
      if (at !== null) openFeedbackAt(at.x, at.y);
    }, LONG_PRESS_MS);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pressOrigin === null) return;
    const dx = e.clientX - pressOrigin.x;
    const dy = e.clientY - pressOrigin.y;
    // 手指挪动了就是在画线，不是长按
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) cancelPress();
  });

  canvas.addEventListener('pointerup', cancelPress);
  canvas.addEventListener('pointercancel', cancelPress);

  settingsPanel = makeSettingsPanel();

  const theStore = store;
  if (theStore !== null) {
    historyPanel = new HistoryPanel(theStore, {
      refresh: async () => {
        const events = await theStore.allEvents();
        // 每一次会话「学了什么」= 用户自己说的第一句话（见 core/history.ts）
        const bySession = new Map<string, BoardEvent[]>();
        for (const e of events) {
          const list = bySession.get(e.sessionId);
          if (list === undefined) bySession.set(e.sessionId, [e]);
          else list.push(e);
        }
        const sessionHints = new Map<string, string>();
        for (const [sessionId, list] of bySession) {
          const hint = deriveSessionHint(list);
          if (hint !== null) sessionHints.set(sessionId, hint);
        }
        return {
          index: await buildSearchIndex(),
          sessions: await theStore.listSessions(),
          sessionHints,
        };
      },
      locate: locateOnBoard,
    });
    dataPanel = makeDataPanel(theStore);
    materialsPanel = makeMaterialsPanel(theStore);
    boardsPanel = makeBoardsPanel(theStore);
  }

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

  // 退回内存存储是**会丢数据**的状态（刷新就没了），所以放在状态条最前面说
  const warning = persistent ? '' : '⚠ 本地存储打不开，这次的数据不会保存 · ';

  /**
   * ⚠️ 状态条是**给用户看的**，别把开发期的代号漏进来。
   *
   * 原来这里写着「M2 · 读回 6 条历史事件 · 续上次会话」——
   * 「M2」是里程碑编号，用户完全不知道那是什么；
   * 「事件」也是实现术语。改成说人话：我在哪块板上、有没有东西。
   */
  const where = boardRecord === null ? '' : `「${boardRecord.title}」· `;
  const howMuch = loadedCount > 0 ? `${String(loadedCount)} 条记录` : '还是空的';
  const when = isNewSession ? '新的一次学习' : '接着上次';
  setStatus(`${warning}${where}${howMuch} · ${when}`);

  // 一个渠道都没有的话，把用户送到渠道设置面前（只提示一次）
  await guideChannelSetup();

  // 配过同步的话，把自动同步开起来（会立刻先同步一次）
  const savedSync = await store?.getMeta<SyncConfig>(SYNC_CONFIG_KEY);
  if (savedSync !== null && savedSync !== undefined) applyAutoSync(savedSync);
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
