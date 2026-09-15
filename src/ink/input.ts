/**
 * 手写输入采集（Pointer Events）
 *
 * 这个文件只做一件事：把浏览器给的指针事件，变成干净的「一笔」。
 * 它不碰渲染，也不碰数据存储 —— 这样将来换成原生低延迟视图时，只需替换这一个文件。
 *
 * 处理了四件必须处理的事（对应技术文档 §5.2 / §5.3）：
 *   ① 掌托误触：笔在用的时候忽略手指
 *   ② 合并采样：一帧内的多个点用 getCoalescedEvents 全部取出，否则快速书写会变折线
 *   ③ 指针捕获：手指/笔滑出画布也能继续画
 *   ④ 指针取消：系统打断（来电、手势）时干净收尾
 */

import type { Point, Stroke, StrokeSource } from './strokes';
import { appendPoint, createStroke } from './strokes';

export interface InkStyle {
  color: string;
  size: number;
  erase: boolean;
}

export interface InkHandlers {
  /** 一笔开始 */
  onBegin(stroke: Stroke): void;
  /** 这一笔有新采样点 */
  onExtend(stroke: Stroke): void;
  /** 一笔正常结束 */
  onEnd(stroke: Stroke): void;
  /** 这一笔被丢弃（掌托、系统打断） */
  onCancel(): void;
}

/**
 * 笔抬起来之后，多久之内仍然忽略手指触摸。
 *
 * 为什么要这个宽限期：写字时手掌常常贴在屏幕上，笔一抬，手掌的触摸事件
 * 紧接着就来了。没有宽限期的话，每写完一笔就会多出一条手掌画出来的线。
 */
const PALM_GRACE_MS = 700;

function sourceOf(e: PointerEvent): StrokeSource {
  if (e.pointerType === 'pen') return 'pen';
  if (e.pointerType === 'touch') return 'touch';
  return 'mouse';
}

/**
 * 把输入采集挂到画布上。
 * @returns 解绑函数（组件销毁时调用）
 */
export function attachInkInput(
  canvas: HTMLCanvasElement,
  handlers: InkHandlers,
  getStyle: () => InkStyle,
): () => void {
  /** 当前正在跟的 pointerId。只有它的事件会被采纳 */
  let activeId: number | null = null;
  let active: Stroke | null = null;
  /** 最近一次收到笔事件的时间戳 */
  let lastPenAt = Number.NEGATIVE_INFINITY;

  function toPoint(e: PointerEvent, source: StrokeSource): Point {
    const r = canvas.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      // 非笔设备的 pressure 不可信，统一记 0 —— 渲染时会按固定宽度处理
      pressure: source === 'pen' ? e.pressure : 0,
      t: e.timeStamp,
    };
  }

  function onPointerDown(e: PointerEvent): void {
    const source = sourceOf(e);

    if (source === 'pen') lastPenAt = e.timeStamp;

    // ① 掌托：笔刚用过，忽略手指
    if (source === 'touch' && e.timeStamp - lastPenAt < PALM_GRACE_MS) return;

    // 手掌先落下、笔后落下 → 把已经开始的触摸笔画丢掉，改由笔来画
    if (source === 'pen' && active !== null && active.source === 'touch') {
      active = null;
      activeId = null;
      handlers.onCancel();
    }

    // 已经有一笔在进行中（多指同时按下时只认第一根）
    if (active !== null) return;

    e.preventDefault();

    // ③ 指针捕获：滑出画布也继续收事件
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // 某些环境下会失败，不影响主流程
    }

    const style = getStyle();
    active = createStroke({
      color: style.color,
      size: style.size,
      erase: style.erase,
      source,
      first: toPoint(e, source),
    });
    activeId = e.pointerId;
    handlers.onBegin(active);
  }

  function onPointerMove(e: PointerEvent): void {
    if (active === null || activeId !== e.pointerId) return;
    e.preventDefault();

    const source = active.source;
    // ② 合并采样：一帧内其实有多个采样点，不取的话快速书写会变成折线（锯齿感）
    const raw = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list: PointerEvent[] = raw.length > 0 ? raw : [e];

    let changed = false;
    for (const ev of list) {
      if (appendPoint(active, toPoint(ev, source))) changed = true;
    }
    if (changed) handlers.onExtend(active);
  }

  function finish(e: PointerEvent, cancelled: boolean): void {
    if (active === null || activeId !== e.pointerId) return;
    const stroke = active;
    active = null;
    activeId = null;

    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // 忽略
    }

    if (cancelled) handlers.onCancel();
    else handlers.onEnd(stroke);
  }

  const onPointerUp = (e: PointerEvent): void => finish(e, false);
  const onPointerCancel = (e: PointerEvent): void => finish(e, true);
  /** 浏览器在 pointerup 之外还可能直接丢指针（例如切到后台） */
  const onLostCapture = (e: PointerEvent): void => finish(e, false);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onLostCapture);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('lostpointercapture', onLostCapture);
  };
}
