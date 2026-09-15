/**
 * IndexedDB 的「缺仓库自愈」测试
 *
 * 这是一个**我踩过两次**的坑，所以专门写测试钉住它：
 *
 * 加对象仓库要改两个地方（版本号 + 建表语句）。分两次改、中间 dev server 热重载，
 * 就会出现「数据库升到了新版本、但仓库没建」——版本号已经走过，
 * 升级回调**再也不会跑**，那个库就永远缺一个仓库，直到第一次用到它才炸。
 *
 * 修法不是"记得一次改完"（不可靠），而是让 `init()` 自己发现并往前升一格。
 * 下面这个测试就是手工制造出那个坏状态，看它能不能自己爬出来。
 */

import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { IndexedDbStore } from './indexedDbStore';

const DB_NAME = 'teach-learn-whiteboard';

/** 把测试用的库删掉，保证每个用例从零开始 */
function deleteDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    // ⚠️ 被别的连接挡住时也要 resolve：否则这个 Promise 永远不落地，
    //    测试会以「超时」结束，而不是一个看得懂的报错
    req.onblocked = () => resolve();
  });
}

describe('缺仓库自愈', () => {
  it('★ 数据库停在某个旧版本、缺仓库时，init() 能自己补上', async () => {
    await deleteDatabase();

    // 手工造出那个坏状态：一个版本号很靠前、但只有一半仓库的数据库
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('events', { keyPath: 'id' });
        db.createObjectStore('boards', { keyPath: 'id' });
        // 故意不建 sessions / meta / attachments / docs / chunks
      };
      req.onsuccess = () => {
        // ★ 一定要关掉：留着这个连接会把后面的升级请求挡住
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    const store = new IndexedDbStore();
    await store.init();

    // 修复之后所有功能都能用
    await expect(store.listDocs()).resolves.toEqual([]);
    await expect(store.listSessions()).resolves.toEqual([]);
    await expect(store.allMeta()).resolves.toEqual([]);
    await expect(store.countChunks()).resolves.toBe(0);

    await store.putDoc({
      id: 'd1', userId: 'local', title: 't', fileName: 'f.txt',
      mime: 'text/plain', chars: 1, chunkCount: 0, importedAt: 1,
    });
    expect(await store.listDocs()).toHaveLength(1);

    // ★ 用完关掉，不然会污染后面的用例
    store.close();
  });

  it('★ 数据库版本比代码里的还新时，仍然能打开（这是自愈之后的常态）', async () => {
    await deleteDatabase();

    // 造一个版本号远超代码常量的库 —— 自愈之后就是这个样子
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 99);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('events', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    /**
     * ⚠️ 这条测试盯的是一个**只在真浏览器里暴露**的 bug：
     * 自愈把数据库升到了比 `DB_VERSION` 更高的版本，而
     * `indexedDB.open(name, 更低的版本)` 会抛 `VersionError`（规范行为）——
     * 于是 App 再也打不开自己的数据库，静默退回内存存储，
     * 「刷新之后数据全没了」。单元测试当时没抓到，是因为这里才第一次覆盖到。
     */
    const store = new IndexedDbStore();
    await store.init();

    // 缺的仓库也自己补上了
    await expect(store.listDocs()).resolves.toEqual([]);
    await expect(store.listSessions()).resolves.toEqual([]);
    await expect(store.countChunks()).resolves.toBe(0);

    store.close();
  });

  it('全新数据库 init() 之后所有仓库都齐', async () => {
    await deleteDatabase();

    const store = new IndexedDbStore();
    await store.init();

    // 每个仓库都实际用一下，缺哪个就会在这里炸
    await expect(store.listDocs()).resolves.toEqual([]);
    await expect(store.listSessions()).resolves.toEqual([]);
    await expect(store.allMeta()).resolves.toEqual([]);
    await expect(store.countChunks()).resolves.toBe(0);
    await expect(store.attachmentBytes()).resolves.toBe(0);
    await expect(store.loadEvents('b1')).resolves.toEqual([]);
    await expect(store.countUnsynced()).resolves.toBe(0);

    // 写进去也读得出来
    await store.putChunks('d1', [
      { id: 'c1', docId: 'd1', ord: 0, heading: null, text: '内容', start: 0, end: 2 },
    ]);
    expect(await store.countChunks()).toBe(1);

    store.close();
  });
});
