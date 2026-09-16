/**
 * 给 pi-ai 的请求套一层 fetch：**摘掉会触发 CORS 预检、但服务端不认的请求头**。
 *
 * ## 这是什么问题
 *
 * pi-ai 底层用 OpenAI 的官方 SDK，而那个 SDK 会给**每一个**请求自动加上一串
 * `x-stainless-*` 头（arch / lang / os / package-version / retry-count /
 * runtime / runtime-version）。
 *
 * 对官方 OpenAI 没问题，但很多 OpenAI **兼容**端点用的是「白名单式」的 CORS 配置：
 * 只允许固定的几个请求头。实测 ModelScope：
 *
 *     Access-Control-Allow-Headers: DNT,Keep-Alive,User-Agent,
 *       X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization
 *
 * 里面**没有** `x-stainless-*`。于是浏览器发预检（OPTIONS）时被判不通过，
 * 请求根本没发出去，前端拿到的是一个 `TypeError: Failed to fetch`。
 *
 * ## 为什么这个 bug 特别难查
 *
 * ① **curl 和 Node 都是通的** —— 它们不发预检。所以「用 curl 试了没问题」
 *    完全不能说明浏览器里没问题。实测：三条 curl 全 200，浏览器里全死。
 * ② `Failed to fetch` 是浏览器把「跨域被拒」和「网线拔了」报成的同一句话，
 *    我们的 explainError 只能猜，猜出来的是「渠道连不上／地址不对／网络不通」——
 *    **全都指错了方向**，用户会去改一个本来就对的地址。
 * ③ 这些头是 SDK 内建的，没有任何选项能关掉（pi-ai 的 `defaultHeaders`
 *    是**追加**，覆盖不掉 SDK 自己的）。
 *
 * ## 修法
 *
 * 在 fetch 这一层把 `x-stainless-*` 删掉。它们纯粹是 SDK 的遥测/调试信息，
 * 删掉不影响任何功能 —— 但预检就能过了。
 *
 * ⚠️ 只删这一族前缀，**不做无差别清洗**：`Authorization`、`Content-Type`
 * 这些是必须留的，而且删错了会静默地改变行为，比原 bug 更难查。
 */

/** 这些是浏览器自己管的头，删了没意义（也不是预检的触发源） */
const NEVER_TOUCH = new Set([
  'authorization',
  'content-type',
  'accept',
  'accept-language',
  'content-length',
]);

/**
 * SDK 自动加、且不在多数兼容端点白名单里的头。
 *
 * 只列我们**确认过**会被拒的；将来再遇到别的，往这里加一条就行。
 */
function isStrippable(name: string): boolean {
  const lower = name.toLowerCase();
  if (NEVER_TOUCH.has(lower)) return false;
  // OpenAI / Anthropic 两家 SDK 用的是同一套 stainless 生成器，前缀一样
  return lower.startsWith('x-stainless-');
}

/** 真实 fetch 的类型（用最小结构，避免把 DOM 的复杂签名抄一遍） */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 包一层：把 `init.headers` 里可摘的头删掉，再交给真正的 fetch。
 *
 * 注意 headers 有三种形态（Headers 实例 / 数组 / 普通对象），
 * 统一用 `new Headers()` 归一化再处理 —— 只认一种形态是这类代码最常见的漏。
 */
export function withCorsSafeHeaders(inner: FetchLike = globalThis.fetch): FetchLike {
  return async (input, init) => {
    if (init?.headers === undefined) return inner(input, init);

    const headers = new Headers(init.headers);
    let removed = 0;
    for (const name of [...headers.keys()]) {
      if (isStrippable(name)) {
        headers.delete(name);
        removed += 1;
      }
    }
    if (removed === 0) return inner(input, init);

    return inner(input, { ...init, headers });
  };
}
