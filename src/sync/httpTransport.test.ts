/**
 * 真·端到端：**拉起真的同步服务进程**，走真的 HTTP
 *
 * 为什么值得单独测一遍（协议逻辑已经用内存服务端测过了）：
 *   ① 内存服务端是我照着协议写的，它和 server/sync-server.mjs **是两份代码** ——
 *      两边行为不一致的话，测试全绿而真服务器上出问题
 *   ② HTTP 层本身有它自己的坑：CORS、超时、状态码、请求体大小
 *   ③ 顺手验一件重要的事：**服务端重启之后数据还在**（它是落盘的）
 */

/** @vitest-environment node */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { EventLog } from '../core/events';
import { composeBoard } from '../core/board';
import { MemoryStore } from '../store/memoryStore';
import { HttpTransport } from './httpTransport';
import { runSync } from './syncEngine';

/**
 * ⚠️ 本机环境设了 HTTP 代理（`HTTP_PROXY` + `NODE_USE_ENV_PROXY=1`），
 * 而 Node 24 的 `fetch` **会走这个代理** —— 于是连 127.0.0.1 的测试服务器
 * 也被转发到代理上，报一个很难懂的 `SocketError: other side closed`。
 *
 * 所以这里显式声明"本地地址不走代理"。
 * （这只影响 Node 里的测试；App 跑在浏览器/WebView 里，用浏览器自己的网络设置。）
 */
process.env['NO_PROXY'] = '127.0.0.1,localhost';
process.env['no_proxy'] = '127.0.0.1,localhost';

type ServerProc = ChildProcessByStdio<null, Readable, Readable>;

const SERVER = join(process.cwd(), 'server', 'sync-server.mjs');

/** 起一个服务器进程，等它把端口打到 stdout */
function startServer(dataFile: string, token?: string): Promise<{ proc: ServerProc; port: number }> {
  return new Promise((resolve, reject) => {
    const args = [SERVER, '--port', '0', '--data', dataFile];
    if (token !== undefined) args.push('--token', token);

    const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('服务器启动超时'));
    }, 15_000);

    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = /PORT=(\d+)/.exec(buffer);
      if (match !== null) {
        clearTimeout(timer);
        resolve({ proc, port: Number(match[1]) });
      }
    });
    // 服务器自己的日志转发出来 —— 它是独立进程，出问题时这些输出是唯一的线索
    proc.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[server:err] ${chunk.toString('utf8')}`);
    });
    proc.on('error', reject);
  });
}

function stopServer(proc: ServerProc): Promise<void> {
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
  });
}

async function makeDevice(deviceId: string) {
  const store = new MemoryStore();
  await store.init();
  const log = new EventLog({ boardId: 'b1', sessionId: `s-${deviceId}`, deviceId });
  return { store, log, deviceId };
}

const running: ServerProc[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const proc = running.pop();
    if (proc !== undefined && proc.exitCode === null) await stopServer(proc);
  }
});

describe('HTTP 同步（真服务器进程）', () => {
  it(
    '★ 两台设备通过真服务器对上，折叠结果一致',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sync-test-'));
      const dataFile = join(dir, 'data.json');

      const { proc, port } = await startServer(dataFile);
      running.push(proc);
      const transport = new HttpTransport({ baseUrl: `http://127.0.0.1:${port}` });

      const A = await makeDevice('dev-A');
      A.log.createBoard('一元二次方程');
      A.log.aiWrite({ op: 'append', html: '<p>A 写的判别式</p>', region: 'a1' });
      await A.store.appendEvents(A.log.all);

      const pushed = await runSync({ store: A.store, transport, deviceId: A.deviceId });
      expect(pushed.pushed).toBe(2);

      const B = await makeDevice('dev-B');
      const pulled = await runSync({ store: B.store, transport, deviceId: B.deviceId });
      expect(pulled.merged).toBe(2);

      // B 也写一块，推上去，A 再拉回来
      B.log.aiWrite({ op: 'append', html: '<p>B 写的求根公式</p>', region: 'b1' });
      await B.store.appendEvents(B.log.all);
      await runSync({ store: B.store, transport, deviceId: B.deviceId });
      await runSync({ store: A.store, transport, deviceId: A.deviceId });

      const eventsA = await A.store.allEvents();
      const eventsB = await B.store.allEvents();
      expect(eventsA.map((e) => e.id)).toEqual(eventsB.map((e) => e.id));
      // ★ 验收标准：两台设备折叠出来的板面完全一致
      expect(composeBoard('b1', eventsA)).toEqual(composeBoard('b1', eventsB));

      await stopServer(proc);
      running.pop();

      // ★ 服务端是落盘的：重启之后数据还在
      expect(existsSync(dataFile)).toBe(true);
      expect(statSync(dataFile).size).toBeGreaterThan(0);

      const second = await startServer(dataFile);
      running.push(second.proc);
      const transport2 = new HttpTransport({ baseUrl: `http://127.0.0.1:${second.port}` });

      const C = await makeDevice('dev-C');
      const restored = await runSync({ store: C.store, transport: transport2, deviceId: C.deviceId });
      expect(restored.merged).toBe(3); // 重启后事件都还在
    },
    30_000,
  );

  it(
    '设置了口令时，口令不对会被拒绝（而且报错带上原因）',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sync-test-'));
      // 口令用 ASCII —— 中文口令会先在客户端被拦下（见下面那条测试）
      const { proc, port } = await startServer(join(dir, 'data.json'), 'correct-horse');
      running.push(proc);

      const baseUrl = `http://127.0.0.1:${port}`;

      // 不带口令
      await expect(
        new HttpTransport({ baseUrl }).sync({ deviceId: 'd', cursor: null, events: [] }),
      ).rejects.toThrow(/401/);

      // 带错的口令
      await expect(
        new HttpTransport({ baseUrl, token: 'wrong' }).sync({
          deviceId: 'd',
          cursor: null,
          events: [],
        }),
      ).rejects.toThrow(/401/);

      // 带对的口令
      const ok = await new HttpTransport({ baseUrl, token: 'correct-horse' }).sync({
        deviceId: 'd',
        cursor: null,
        events: [],
      });
      expect(ok.events).toEqual([]);
    },
    20_000,
  );

  it('★ 中文口令会给人话，而不是那句没人看得懂的 ByteString 报错', async () => {
    const transport = new HttpTransport({ baseUrl: 'http://127.0.0.1:1', token: '我的口令' });
    await expect(transport.sync({ deviceId: 'd', cursor: null, events: [] })).rejects.toThrow(
      /只能用英文字母/,
    );
  });

  it(
    '健康检查能看到库里有多少事件',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sync-test-'));
      const { proc, port } = await startServer(join(dir, 'data.json'));
      running.push(proc);

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { ok: boolean; events: number };
      expect(body.ok).toBe(true);
      expect(body.events).toBe(0);
    },
    20_000,
  );

  it(
    '服务器不可达时抛出可读的错误（而不是静默失败）',
    async () => {
      // 一个几乎不可能有人监听的端口
      const transport = new HttpTransport({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1500 });
      await expect(transport.sync({ deviceId: 'd', cursor: null, events: [] })).rejects.toThrow();
    },
    10_000,
  );
});
