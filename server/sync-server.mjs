#!/usr/bin/env node
/**
 * 共写白板 · 参考同步服务端
 *
 * 一个零依赖的 Node 脚本。它的全部工作只有两件：
 *   ① 把客户端推上来的事件**按 id 存下来**
 *   ② 把比客户端游标新的事件**还给它**
 *
 * 它完全不理解「板」「块」「笔迹」是什么 —— 因为事件是不可变的，
 * 服务端不需要懂语义就能正确同步。这就是选事件日志当唯一真相的好处。
 *
 * ── 怎么跑 ────────────────────────────────────────────────────
 *
 *   node server/sync-server.mjs
 *   node server/sync-server.mjs --port 9000 --data ./my-sync.json --token 我的口令
 *
 * 然后在 App 的「⚙️ 渠道」旁边填这个地址（M6 会加一个同步设置入口）。
 *
 * ── ⚠️ 安全边界（重要）────────────────────────────────────────
 *
 * 这是一个**给你自己用**的同步服务：没有账号体系，数据是明文 JSON。
 * 所以：
 *   · 只在你自己的机器 / 局域网 / 内网里跑，**不要直接暴露到公网**
 *   · 要给公网用就：加 --token + 套一层 HTTPS 反向代理（Caddy / Nginx）
 *   · 数据文件请自己做好备份 —— 它是同步的中心，丢了就都丢了
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 参数 ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { port: 8787, data: './sync-data.json', token: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--port' && value !== undefined) out.port = Number(value);
    else if (key === '--data' && value !== undefined) out.data = value;
    else if (key === '--token' && value !== undefined) out.token = value;
  }
  return out;
}

// ── 事件的全局排序（必须和客户端 core/sync.ts 里那套完全一致）──

function cursorOf(event) {
  return { createdAt: event.createdAt, deviceId: event.deviceId, id: event.id };
}

function compareCursor(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function latestCursor(events) {
  let best = null;
  for (const e of events) {
    const c = cursorOf(e);
    if (best === null || compareCursor(c, best) > 0) best = c;
  }
  return best;
}

// ── 存储：一个 JSON 文件，够用且看得见摸得着 ──────────────────

function createStore(dataFile) {
  /** @type {Map<string, object>} */
  let byId = new Map();

  if (existsSync(dataFile)) {
    try {
      const raw = JSON.parse(readFileSync(dataFile, 'utf8'));
      if (Array.isArray(raw.events)) {
        for (const e of raw.events) byId.set(e.id, e);
      }
    } catch (err) {
      console.error(`⚠️  数据文件读不出来（${dataFile}）：${err.message}`);
      console.error('    以空库启动。原文件没有被覆盖 —— 请先自己检查一下。');
      byId = new Map();
    }
  }

  let pending = null;
  function flush() {
    pending = null;
    const payload = JSON.stringify({ savedAt: Date.now(), events: [...byId.values()] });
    writeFileSync(dataFile, payload, 'utf8');
  }

  return {
    size: () => byId.size,
    all: () => [...byId.values()],

    /** 收下一批事件（按 id 去重，所以重复推送无害） */
    put(events) {
      for (const e of events) {
        if (e && typeof e.id === 'string') byId.set(e.id, e);
      }
      // 合并多次写入，避免连着来两个请求就写两次盘
      if (pending === null) pending = setTimeout(flush, 200);
    },

    /** 进程要退出时立刻落盘 */
    close() {
      if (pending !== null) clearTimeout(pending);
      flush();
    },
  };
}

// ── 协议处理 ──────────────────────────────────────────────────

function handleSync(store, body) {
  const events = Array.isArray(body.events) ? body.events : [];
  const cursor = body.cursor ?? null;

  store.put(events);

  const all = store.all();
  const newer = cursor === null ? all : all.filter((e) => compareCursor(cursorOf(e), cursor) > 0);
  newer.sort((a, b) => compareCursor(cursorOf(a), cursorOf(b)));

  return { cursor: latestCursor(all), events: newer };
}

// ── HTTP ──────────────────────────────────────────────────────

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32 MB：一次同步推几千条事件也够

export function startServer(options) {
  const dataFile = resolve(options.data);
  const store = createStore(dataFile);

  const server = createServer((req, res) => {
    // ⚠️ 允许跨域：App 是网页/WebView，直接调这个服务会被 CORS 挡住。
    //    这里放开是因为它本来就是「你自己的服务」，真正的保护是 --token + 别暴露到公网。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      const all = store.all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, events: store.size(), cursor: latestCursor(all) }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/sync') {
      if (options.token !== '' && options.token !== undefined) {
        const auth = req.headers['authorization'] ?? '';
        if (auth !== `Bearer ${options.token}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '口令不对' }));
          return;
        }
      }

      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '这一批太大了，分几次推' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (res.writableEnded) return;
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
          return;
        }
        try {
          const result = handleSync(store, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          const pushed = Array.isArray(body.events) ? body.events.length : 0;
          console.log(
            `同步：收到 ${pushed} 条，返回 ${result.events.length} 条，库里共 ${store.size()} 条`,
          );
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '没有这个接口' }));
  });

  server.listen(options.port, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : options.port;
    console.log(`共写白板 · 同步服务已启动`);
    console.log(`  地址：http://127.0.0.1:${port}`);
    console.log(`  数据：${dataFile}`);
    console.log(`  口令：${options.token === '' ? '（没设，别暴露到公网）' : '已设置'}`);
    console.log(`  PORT=${port}`);
  });

  const shutdown = () => {
    console.log('\n正在落盘并退出…');
    store.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, store };
}

// 直接运行时才启动（被 import 时不自动跑）
if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  startServer(parseArgs(process.argv.slice(2)));
}
