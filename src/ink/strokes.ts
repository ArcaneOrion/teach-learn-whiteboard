/**
 * 笔画数据模型
 *
 * 「一笔」的全部信息都在这里。它同时服务三个用途：
 *   1. 渲染
 *   2. 撤销 / 重做
 *   3. 将来变成事件日志里的 `ink.stroke` 事件，用于同步与回放
 *
 * 坐标用「画布 CSS 像素」，不用设备像素 —— 设备像素会随屏幕缩放变化，
 * 存下来换台设备就对不上了。
 */

/** 输入设备类型。压感只有笔（pen）才有，手指和鼠标没有。 */
export type StrokeSource = 'pen' | 'touch' | 'mouse';

export interface Point {
  /** 相对画布左上角的 CSS 像素 */
  x: number;
  y: number;
  /** 压感 0~1。非笔设备此值不可信，渲染时按固定宽度处理 */
  pressure: number;
  /** 事件时间戳（毫秒）。撤销、回放、同步排序都要用 */
  t: number;
}

export interface Stroke {
  id: string;
  /** CSS 颜色值 */
  color: string;
  /** 基础线宽（CSS 像素） */
  size: number;
  /** true = 橡皮（渲染时用 destination-out 挖掉） */
  erase: boolean;
  source: StrokeSource;
  points: Point[];
}

let seq = 0;

/**
 * 生成笔画 id。
 * 「时间戳 + 自增」保证同一设备内不重复；将来加 deviceId 前缀即可全局唯一（同步要用）。
 */
export function newStrokeId(now: number = Date.now()): string {
  seq += 1;
  return `${now.toString(36)}-${seq.toString(36)}`;
}

export function createStroke(params: {
  color: string;
  size: number;
  erase: boolean;
  source: StrokeSource;
  first: Point;
}): Stroke {
  return {
    id: newStrokeId(),
    color: params.color,
    size: params.size,
    erase: params.erase,
    source: params.source,
    points: [params.first],
  };
}

/**
 * 两个采样点小于这个距离就认为重复。
 * 单位：CSS 像素。
 */
const MIN_DISTANCE = 0.6;

/**
 * 追加一个采样点。
 *
 * 为什么要去重：一帧内的合并采样（getCoalescedEvents）在笔停住时会产生大量
 * 坐标几乎相同的点。留着它们会让点数暴涨、渲染变慢，画出来却毫无区别。
 *
 * @returns 是否真的追加了（被判定为重复则返回 false）
 */
export function appendPoint(stroke: Stroke, p: Point): boolean {
  const last = stroke.points[stroke.points.length - 1];
  if (last !== undefined) {
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    if (dx * dx + dy * dy < MIN_DISTANCE * MIN_DISTANCE) return false;
  }
  stroke.points.push(p);
  return true;
}
