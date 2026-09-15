/**
 * 自动同步的调度（技术文档 §13）
 *
 * ## 为什么要它
 *
 * 「数据只在设备本地、卸载即删」是这个产品**刻意选的代价**（换来零危险权限）。
 * 那就更不该指望用户记得手动点「立即同步」—— 忘记一次就可能丢掉几周的笔记。
 *
 * ## 两条节奏，而不是一个定时器
 *
 * 一个固定间隔会有个两难：定得短（比如 30 秒）费电费流量；定得长（比如 10 分钟）
 * 又会出现"刚写完就关 App，结果没同步上"。
 *
 * 所以分成两条：
 *   · **改了就同步**：本机一有新事件，等 `debounceMs`（默认 20 秒）没有新动静就同步一次
 *     —— 连续写字时不会每笔都发请求，停手 20 秒才发
 *   · **心跳**：每 `intervalMs`（默认 5 分钟）同步一次，用来**拿到别的设备写的**
 *     —— 本机没动静的时候也需要知道远端有没有新东西
 *
 * ## 三条不能少的约束
 *
 * 1. **不重入**：上一轮还没跑完就不开新的（网络慢时尤其重要）
 * 2. **失败不致命**：离线是常态，出错了安静记下来，下一次照样跑
 *     —— 绝不能因为一次失败就把定时器停了
 * 3. **stop() 要停干净**：两个定时器、一个进行中的标记，都要清掉
 */

export interface SyncOutcome {
  pushed: number;
  pulled: number;
  /** 拉到几条本机原先没有的 */
  merged: number;
}

export interface AutoSyncOptions {
  /** 真的跑一次同步 */
  sync: () => Promise<SyncOutcome>;
  /** 心跳间隔，默认 5 分钟 */
  intervalMs?: number;
  /** 有变化之后等多久再同步，默认 20 秒 */
  debounceMs?: number;
  onResult?: (outcome: SyncOutcome) => void;
  onError?: (error: unknown) => void;
  /** 出错时告诉调度器要不要继续（默认继续）—— 比如"没配服务端"就该停 */
  shouldContinueAfterError?: (error: unknown) => boolean;
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS = 20 * 1000;

export class AutoSync {
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** 正在跑一次同步 —— 用来防止重入 */
  private inFlight = false;
  private stopped = true;
  private lastAt: number | null = null;

  constructor(private readonly options: AutoSyncOptions) {}

  /** 上次同步成功是什么时候（毫秒时间戳）；从没成功过就是 null */
  get lastSyncAt(): number | null {
    return this.lastAt;
  }

  get isRunning(): boolean {
    return this.heartbeat !== null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.heartbeat = setInterval(() => {
      void this.runNow('心跳');
    }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.heartbeat = null;
    this.debounce = null;
  }

  /**
   * 本机有新事件了。
   *
   * 反复调用只会**推迟**那一次同步（不会排队好几个）——
   * 所以连着写十笔也只在停手之后发一个请求。
   */
  notifyChange(): void {
    if (this.stopped) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.runNow('有新内容');
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  /** 立刻同步一次（启动时、用户手动点完之后用） */
  async runNow(reason: string): Promise<void> {
    // ① 不重入
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const outcome = await this.options.sync();
      this.lastAt = (this.options.now ?? Date.now)();
      this.options.onResult?.(outcome);
      void reason;
    } catch (error) {
      this.options.onError?.(error);
      // ② 默认继续跑 —— 一次网络抖动不该把自动同步永久关掉
      if (this.options.shouldContinueAfterError?.(error) === false) this.stop();
    } finally {
      this.inFlight = false;
    }
  }
}
