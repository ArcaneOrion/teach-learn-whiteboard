/**
 * 会话（session）
 *
 * 技术文档 §8 的两个正交概念：
 *   · **板 = 一个主题**（长期存在，跨天跨月）
 *   · **会话 = 一次坐下来学习**（有开始和结束）
 *
 * 一次会话里可能翻好几块板；一块板会被很多次会话反复写到。所以事件同时带
 * `boardId` 和 `sessionId` 两个归属。
 *
 * 这个文件只做一件事：**判断"现在这次交互属于哪个会话"**。
 * 它是一个纯函数，所以能被完整测试覆盖。
 */

export interface SessionRecord {
  id: string;
  userId: string;
  title: string | null;
  /** UTC 毫秒 */
  startedAt: number;
  /** null = 还在进行中 */
  endedAt: number | null;
  /** 最后一次有事件的时间 */
  lastActive: number;
  deviceId: string;
}

/** 空闲多久算"这次学习结束了"。15 分钟的取舍见技术文档 §8.2 */
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

export interface SessionContext {
  userId: string;
  deviceId: string;
  /** 便于测试注入更短的阈值 */
  idleMs?: number;
  /** 生成新会话 id */
  newId: () => string;
}

export interface SessionDecision {
  /** 现在应该用哪个会话 */
  session: SessionRecord;
  /** 是不是新开的 */
  isNew: boolean;
  /**
   * 如果上一个会话刚刚被判定结束，这里是**结束时间已经补好**的那一条。
   * 调用方需要把它写回存储 —— 不写的话它就永远停在"进行中"。
   */
  closed: SessionRecord | null;
}

/**
 * 决定"现在这次交互属于哪个会话"。
 *
 * ★ 关键设计：**不做后台任务监控空闲**，而是在下次开始时"补算"。
 *
 * 为什么：
 *   · 后台常驻费电，安卓杀后台又很凶，本来就不可靠
 *   · 可能还要通知/前台服务权限 —— 违背本项目的"零权限"原则
 *   · 最难测
 *
 * 补算的好处：零后台任务、零权限、**一个纯函数，单测三行**。
 * 而且反正你也不可能在没打开 App 的时候产生学习记录。
 *
 * @param now  现在（UTC 毫秒）
 * @param last 上一次会话（没有就传 null）
 */
export function resolveSession(
  now: number,
  last: SessionRecord | null,
  ctx: SessionContext,
): SessionDecision {
  const idleMs = ctx.idleMs ?? DEFAULT_IDLE_MS;

  // ① 上一个会话还在进行中，且没超过空闲阈值 → 续上
  if (last !== null && last.endedAt === null && now - last.lastActive <= idleMs) {
    return {
      session: { ...last, lastActive: now },
      isNew: false,
      closed: null,
    };
  }

  // ② 上一个会话超时了 → 补一个结束时间，再开新的
  const closed =
    last !== null && last.endedAt === null
      ? { ...last, endedAt: last.lastActive + idleMs }
      : null;

  return {
    session: {
      id: ctx.newId(),
      userId: ctx.userId,
      title: null,
      startedAt: now,
      endedAt: null,
      lastActive: now,
      deviceId: ctx.deviceId,
    },
    isNew: true,
    closed,
  };
}

/** 会话时长（毫秒）。进行中的会话按"最后一次活动"算 */
export function sessionDuration(s: SessionRecord): number {
  return (s.endedAt ?? s.lastActive) - s.startedAt;
}
