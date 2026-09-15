/**
 * 会话日期分组的测试
 *
 * 时区是这块最容易出错的地方：存的是 UTC 毫秒，「哪一天」却要按**本地时区**算。
 * 用 toISOString() 取日期的话，在中国（UTC+8）晚上 8 点之后的学习会被算到"第二天" ——
 * 而且这个 bug 只在晚上出现，白天怎么测都是对的。
 *
 * 测试里所有时间戳都用 `new Date(y, m, d, h, ...)` 构造，那是**本地时区**，
 * 所以这些断言在哪个时区跑都成立。
 */

import { describe, expect, it } from 'vitest';

import type { SessionRecord } from './session';
import {
  dayLabel,
  groupSessionsByDay,
  humanDuration,
  localDayKey,
  sessionTitle,
} from './history';

function at(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function session(over: Partial<SessionRecord> & { id: string; startedAt: number }): SessionRecord {
  return {
    userId: 'local',
    title: null,
    endedAt: over.startedAt + 10 * 60 * 1000,
    lastActive: over.startedAt + 10 * 60 * 1000,
    deviceId: 'dev',
    ...over,
  };
}

describe('localDayKey', () => {
  it('按**本地时区**算日期，不是 UTC', () => {
    // 本地时间 2026-09-15 23:30 —— UTC 那边可能已经是 16 号了
    expect(localDayKey(at(2026, 9, 15, 23, 30))).toBe('2026-09-15');
    // 本地时间 00:10 也一样
    expect(localDayKey(at(2026, 9, 15, 0, 10))).toBe('2026-09-15');
  });

  it('★ 深夜和凌晨属于各自的本地日期，不会被算到同一天', () => {
    expect(localDayKey(at(2026, 9, 15, 23, 59))).not.toBe(localDayKey(at(2026, 9, 16, 0, 1)));
  });

  it('月份和日期补零', () => {
    expect(localDayKey(at(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('dayLabel', () => {
  const now = at(2026, 9, 15, 20, 0);

  it('今天 / 昨天', () => {
    expect(dayLabel('2026-09-15', now)).toBe('今天');
    expect(dayLabel('2026-09-14', now)).toBe('昨天');
  });

  it('同年只写月日，跨年带上年份', () => {
    expect(dayLabel('2026-08-17', now)).toBe('8月17日');
    expect(dayLabel('2025-12-31', now)).toBe('2025年12月31日');
  });
});

describe('groupSessionsByDay', () => {
  const now = at(2026, 9, 15, 20, 0);

  it('按本地日期分组，日期倒序', () => {
    const groups = groupSessionsByDay(
      [
        session({ id: 's1', startedAt: at(2026, 9, 13, 9) }),
        session({ id: 's2', startedAt: at(2026, 9, 15, 9) }),
        session({ id: 's3', startedAt: at(2026, 9, 14, 9) }),
      ],
      now,
    );

    expect(groups.map((g) => g.key)).toEqual(['2026-09-15', '2026-09-14', '2026-09-13']);
    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天', '9月13日']);
  });

  it('同一天的多次会话合并到一组，新的在前', () => {
    const groups = groupSessionsByDay(
      [
        session({ id: 'morning', startedAt: at(2026, 9, 15, 9) }),
        session({ id: 'night', startedAt: at(2026, 9, 15, 21) }),
      ],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['night', 'morning']);
  });

  it('★ 跨越午夜的学习算在**开始**的那一天', () => {
    const groups = groupSessionsByDay(
      [
        session({
          id: 'late',
          startedAt: at(2026, 9, 14, 23, 50),
          endedAt: at(2026, 9, 15, 0, 30),
          lastActive: at(2026, 9, 15, 0, 30),
        }),
      ],
      now,
    );
    // 算 14 号而不是 15 号
    expect(groups[0]?.key).toBe('2026-09-14');
  });

  it('算出每天的总时长', () => {
    const groups = groupSessionsByDay(
      [
        session({ id: 'a', startedAt: at(2026, 9, 15, 9), endedAt: at(2026, 9, 15, 9, 30), lastActive: at(2026, 9, 15, 9, 30) }),
        session({ id: 'b', startedAt: at(2026, 9, 15, 20), endedAt: at(2026, 9, 15, 20, 45), lastActive: at(2026, 9, 15, 20, 45) }),
      ],
      now,
    );
    expect(groups[0]?.totalMs).toBe(75 * 60 * 1000);
  });

  it('没有会话时返回空数组', () => {
    expect(groupSessionsByDay([], now)).toEqual([]);
  });
});

describe('humanDuration', () => {
  it('说人话', () => {
    expect(humanDuration(0)).toBe('不到 1 分钟');
    expect(humanDuration(30_000)).toBe('不到 1 分钟');
    expect(humanDuration(35 * 60_000)).toBe('35 分钟');
    expect(humanDuration(60 * 60_000)).toBe('1 小时');
    expect(humanDuration(80 * 60_000)).toBe('1 小时 20 分');
  });
});

describe('sessionTitle', () => {
  it('用户命名过就用名字', () => {
    expect(sessionTitle(session({ id: 's', startedAt: at(2026, 9, 15, 20), title: '复习判别式' }))).toBe('复习判别式');
  });

  it('没命名就用开始时间', () => {
    expect(sessionTitle(session({ id: 's', startedAt: at(2026, 9, 15, 20, 5) }))).toBe('20:05 开始的学习');
  });

  it('空白标题当成没命名', () => {
    expect(sessionTitle(session({ id: 's', startedAt: at(2026, 9, 15, 8, 0), title: '   ' }))).toBe('08:00 开始的学习');
  });
});
