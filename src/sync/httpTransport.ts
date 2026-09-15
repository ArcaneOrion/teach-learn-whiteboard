/**
 * HTTP 同步传输（对着 server/sync-server.mjs 那套协议）
 *
 * 一个请求搞定推和拉。失败**原样抛出**，由调用方决定怎么呈现 ——
 * 这一层不该知道"要不要说人话"，那是 ui 的事。
 */

import type { SyncRequest, SyncResponse, SyncTransport } from './protocol';

export interface HttpTransportOptions {
  /** 服务端地址，例如 http://192.168.1.5:8787 */
  baseUrl: string;
  /** 可选的共享口令（服务端配了才需要） */
  token?: string;
  /** 单次请求超时（毫秒）。同步是后台行为，卡住不如早点放弃重试 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * HTTP 请求头**只能放 ASCII**。
 *
 * ⚠️ 踩过：用户把口令设成中文时，`fetch` 会抛
 *    `Cannot convert argument to a ByteString because the character at index 7 …`
 * —— 对着这句话没人猜得到"口令不能用中文"。
 * 所以在这里提前拦下，换成一句人话。
 */
const HEADER_SAFE = /^[\x20-\x7E]*$/;

export class HttpTransport implements SyncTransport {
  constructor(private readonly options: HttpTransportOptions) {}

  async sync(request: SyncRequest): Promise<SyncResponse> {
    const token = this.options.token ?? '';
    if (!HEADER_SAFE.test(token)) {
      throw new Error('同步口令只能用英文字母、数字和常见符号（HTTP 请求头放不下中文）。换一个口令吧。');
    }

    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token !== '') {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!res.ok) {
        // 把服务端返回的说明带上，否则用户只看到一句"HTTP 500"
        const detail = await res.text().catch(() => '');
        const extra = detail.trim() === '' ? '' : `：${detail.trim().slice(0, 200)}`;
        throw new Error(`同步服务返回 HTTP ${res.status}${extra}`);
      }

      return (await res.json()) as SyncResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}
