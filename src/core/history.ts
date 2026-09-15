/**
 * 会话的日期分组（技术文档 §8.3）
 *
 * 产品文档第 8 节：**板 = 主题（长期），会话 = 一次坐下来学习（有始有终）**。
 * 这里回答的是「我上周三晚上干了什么」这类问题。
 *
 * ⚠️ 时区是这块最容易出错的地方：
 *   存的时间戳统一是 **UTC 毫秒**，但「哪一天」必须按**本地时区**算。
 *   直接用 `new Date(ts).toISOString().slice(0,10)` 会得到 UTC 的日期 ——
 *   在中国（UTC+8），晚上 8 点之后的学习会被算到"第二天"。
 */

import type { SessionRecord } from './session';
import { sessionDuration } from './session';

/**
 * 时间戳 → 本地时区的日期键 `YYYY-MM-DD`。
 *
 * 用 `getFullYear/getMonth/getDate` 而不是 toISOString —— 前者是本地时区，后者是 UTC。
 */
export function localDayKey(timestamp: number): string {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface DayGroup {
  /** `YYYY-MM-DD`（本地时区） */
  key: string;
  /** 显示用的标签：今天 / 昨天 / 8月17日 */
  label: string;
  /** 这一天学了多久（毫秒） */
  totalMs: number;
  /** 这一天的会话，新的在前 */
  sessions: SessionRecord[];
}

/** 把标签算出来单放一个函数，方便测（它依赖"今天"，所以要显式传 now） */
export function dayLabel(dayKey: string, now: number): string {
  const today = localDayKey(now);
  if (dayKey === today) return '今天';

  const yesterday = localDayKey(now - 24 * 60 * 60 * 1000);
  if (dayKey === yesterday) return '昨天';

  const [y, m, d] = dayKey.split('-');
  const thisYear = localDayKey(now).slice(0, 4);
  // 跨年了就把年份也写上，否则只写月日就够了
  return y === thisYear ? `${Number(m)}月${Number(d)}日` : `${y}年${Number(m)}月${Number(d)}日`;
}

/**
 * 按本地日期分组。
 *
 * @param sessions 不必预先排序
 * @param now      显式传入"现在"，让这个函数保持纯净、可测
 */
export function groupSessionsByDay(
  sessions: readonly SessionRecord[],
  now: number,
): DayGroup[] {
  const byDay = new Map<string, SessionRecord[]>();

  for (const s of sessions) {
    // ⚠️ 用 startedAt 而不是 lastActive 分组：
    //    一次从 23:50 学到次日 0:30 的会话，应该算在开始的那一天
    const key = localDayKey(s.startedAt);
    const bucket = byDay.get(key);
    if (bucket === undefined) byDay.set(key, [s]);
    else bucket.push(s);
  }

  const groups: DayGroup[] = [];
  for (const [key, list] of byDay) {
    list.sort((a, b) => b.startedAt - a.startedAt);
    let totalMs = 0;
    for (const s of list) totalMs += sessionDuration(s);
    groups.push({ key, label: dayLabel(key, now), totalMs, sessions: list });
  }

  // 日期倒序（新的在前）；日期键是 YYYY-MM-DD，字符串比较就等于时间比较
  groups.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return groups;
}

/** 把毫秒说成人话：「1 小时 20 分」/「35 分钟」/「不到 1 分钟」 */
export function humanDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

/** 会话显示用的标题：用户命名过就用名字，否则按时间描述 */
export function sessionTitle(session: SessionRecord): string {
  if (session.title !== null && session.title.trim() !== '') return session.title;
  const d = new Date(session.startedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} 开始的学习`;
}
