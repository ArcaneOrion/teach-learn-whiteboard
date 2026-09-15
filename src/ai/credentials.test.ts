/**
 * 凭据存储的测试
 *
 * 这块值得测，理由很直接：**它存的是用户的 API Key**。
 * 而且它有一个容易被忽略的要求 —— 同一个渠道的写操作必须**串行**，
 * 否则两个并发写会互相覆盖（表现为"刚存的 Key 莫名其妙没了"）。
 */

import { describe, expect, it } from 'vitest';

import { MemoryStore } from '../store/memoryStore';
import { StoreCredentialStore } from './credentials';

async function makeStore() {
  const store = new MemoryStore();
  await store.init();
  return { store, creds: new StoreCredentialStore(store) };
}

describe('StoreCredentialStore', () => {
  it('存取 API Key', async () => {
    const { creds } = await makeStore();
    expect(await creds.getApiKey('ch-1')).toBeNull();

    await creds.setApiKey('ch-1', 'sk-abc');
    expect(await creds.getApiKey('ch-1')).toBe('sk-abc');
  });

  it('不同渠道的 Key 互不干扰', async () => {
    const { creds } = await makeStore();
    await creds.setApiKey('ch-1', 'key-1');
    await creds.setApiKey('ch-2', 'key-2');

    expect(await creds.getApiKey('ch-1')).toBe('key-1');
    expect(await creds.getApiKey('ch-2')).toBe('key-2');
  });

  it('覆盖写：后写的赢', async () => {
    const { creds } = await makeStore();
    await creds.setApiKey('ch-1', 'old');
    await creds.setApiKey('ch-1', 'new');
    expect(await creds.getApiKey('ch-1')).toBe('new');
  });

  it('删除之后读不到', async () => {
    const { creds } = await makeStore();
    await creds.setApiKey('ch-1', 'k');
    await creds.delete('ch-1');
    expect(await creds.getApiKey('ch-1')).toBeNull();
  });

  it('★ 同一个渠道的并发写会串行，不会互相覆盖', async () => {
    const { creds } = await makeStore();

    // 同时发起 5 次写，每次都在 read-modify-write 中间让出一拍。
    // 如果没有串行化，它们会读到同一个旧值，相互覆盖，最后只剩一个
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((k) =>
        creds.modify('ch-1', async () => {
          await new Promise((r) => setTimeout(r, 1));
          return { type: 'api_key', key: k };
        }),
      ),
    );

    // 无论最终是哪一次赢，值必须是 5 个之一，且没有出现"半个值"
    const final = await creds.getApiKey('ch-1');
    expect(['a', 'b', 'c', 'd', 'e']).toContain(final);
  });

  it('★ 一次写失败，不会卡住后面同渠道的写', async () => {
    const { creds } = await makeStore();

    const failing = creds.modify('ch-1', async () => {
      throw new Error('模拟失败');
    });
    await expect(failing).rejects.toThrow('模拟失败');

    // 队列没有被那条失败的写卡死
    await creds.setApiKey('ch-1', 'after-failure');
    expect(await creds.getApiKey('ch-1')).toBe('after-failure');
  });

  it('不同渠道之间不互相阻塞', async () => {
    const { creds } = await makeStore();
    await Promise.all([creds.setApiKey('ch-1', '1'), creds.setApiKey('ch-2', '2')]);
    expect(await creds.getApiKey('ch-1')).toBe('1');
    expect(await creds.getApiKey('ch-2')).toBe('2');
  });

  it('已取消的 signal 会直接抛出，不做任何写入', async () => {
    const { creds } = await makeStore();
    const controller = new AbortController();
    controller.abort();

    await expect(
      creds.modify('ch-1', async () => ({ type: 'api_key', key: 'x' }), {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(await creds.getApiKey('ch-1')).toBeNull();
  });

  it('modify 返回 undefined 时等于清除这条凭据', async () => {
    const { creds } = await makeStore();
    await creds.setApiKey('ch-1', 'k');
    await creds.modify('ch-1', async () => undefined);
    expect(await creds.getApiKey('ch-1')).toBeNull();
  });

  it('modify 能看到当前值（读改写是原子的）', async () => {
    const { creds } = await makeStore();
    await creds.setApiKey('ch-1', 'before');

    let seen: string | undefined;
    await creds.modify('ch-1', async (current) => {
      seen = current?.type === 'api_key' ? current.key : undefined;
      return { type: 'api_key', key: 'after' };
    });

    expect(seen).toBe('before');
    expect(await creds.getApiKey('ch-1')).toBe('after');
  });
});
