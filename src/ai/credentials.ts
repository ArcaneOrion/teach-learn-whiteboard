/**
 * 凭据存储（用户自己的 API Key）
 *
 * pi-ai 的 CredentialStore 接口，实现落在我们自己的存储上（IndexedDB 里的一张 meta 表）。
 *
 * ★ 安全承诺：**Key 只在本机，绝不上传**（产品文档第 12 节）。
 *   这一条不是靠"我们不去读它"来保证的，而是靠**这个 App 里根本没有上传 Key 的代码**。
 */

import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';

import type { Store } from '../store/types';

/** meta 表里的键前缀 */
const PREFIX = 'credential:';

function keyOf(providerId: string): string {
  return `${PREFIX}${providerId}`;
}

export class StoreCredentialStore implements CredentialStore {
  constructor(private readonly store: Store) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const row = await this.store.getMeta<Credential>(keyOf(providerId));
    return row ?? undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    // meta 表是按 key 存的，这里只需要"有哪些渠道存了凭据"。
    // 我们不额外维护索引 —— 渠道列表本来就存在别处，这里只做存在性判断。
    return [];
  }

  /**
   * 唯一的写入口。
   *
   * `fn` 会拿到当前凭据 —— 这是刻意的：正确的写入（刷新令牌、登录时正好在刷新）
   * 依赖"读改写"是原子的。我们的实现按渠道串行化，避免并发写互相覆盖。
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.enqueue(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) {
        await this.store.setMeta(keyOf(providerId), null);
      } else {
        await this.store.setMeta(keyOf(providerId), next);
      }
      return next;
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.enqueue(providerId, async () => {
      await this.store.setMeta(keyOf(providerId), null);
    });
  }

  // ── 串行化：同一个渠道的写操作排队，避免并发覆盖 ─────────────

  private readonly chains = new Map<string, Promise<unknown>>();

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(providerId) ?? Promise.resolve();
    // 前一个失败不能卡住后面的
    const next = prev.then(task, task);
    this.chains.set(
      providerId,
      next.catch(() => undefined),
    );
    return next;
  }

  // ── 给界面用的便捷方法（不走 pi-ai 接口）──────────────────

  async getApiKey(providerId: string): Promise<string | null> {
    const cred = await this.read(providerId);
    return cred?.type === 'api_key' ? (cred.key ?? null) : null;
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.modify(providerId, async () => ({ type: 'api_key', key: apiKey }));
  }
}
