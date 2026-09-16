/**
 * corsSafeFetch 的测试
 *
 * 这个修法解决的是一个**只有浏览器会中招**的问题：OpenAI SDK 给每个请求自动加
 * `x-stainless-*`，而白名单式 CORS 的兼容端点（实测 ModelScope）不认这些头，
 * 预检就被挡 → 前端只拿到 `TypeError: Failed to fetch`。
 * curl / Node 不发预检，所以它们全通 —— 这正是它难查的原因。
 *
 * 测试重点有两头：
 *   ① 该摘的必须摘干净（否则预检照样挂）
 *   ② **不该动的一个都不能动** —— 把 Authorization 误删会变成 401，
 *      比原来的 bug 更隐蔽
 */

import { describe, expect, it } from 'vitest';

import { withCorsSafeHeaders, type FetchLike } from './corsSafeFetch';

/** 记下真正传下去的头，然后回一个假响应 */
function spyFetch(): { fetch: FetchLike; headersOf: () => Headers } {
  let captured: Headers | null = null;
  const fetch: FetchLike = async (_input, init) => {
    captured = new Headers(init?.headers ?? {});
    return new Response('{}', { status: 200 });
  };
  return { fetch, headersOf: () => captured as unknown as Headers };
}

const SDK_HEADERS = {
  'x-stainless-arch': 'x64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'Linux',
  'x-stainless-package-version': '6.40.0',
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.14.0',
};

describe('withCorsSafeHeaders', () => {
  it('★ 把 x-stainless-* 全部摘掉（否则 ModelScope 的预检过不了）', async () => {
    const spy = spyFetch();
    const wrapped = withCorsSafeHeaders(spy.fetch);

    await wrapped('https://example.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SDK_HEADERS },
    });

    const left = [...spy.headersOf().keys()];
    expect(left.filter((h) => h.startsWith('x-stainless-'))).toEqual([]);
  });

  it('★ Authorization 和 Content-Type 必须原样留着（删了就变 401）', async () => {
    const spy = spyFetch();
    const wrapped = withCorsSafeHeaders(spy.fetch);

    await wrapped('https://example.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-test', 'Content-Type': 'application/json', ...SDK_HEADERS },
    });

    const h = spy.headersOf();
    expect(h.get('authorization')).toBe('Bearer sk-test');
    expect(h.get('content-type')).toBe('application/json');
  });

  it('方法、body、其它 init 字段都不能被吃掉', async () => {
    let seen: RequestInit | undefined;
    const wrapped = withCorsSafeHeaders(async (_i, init) => {
      seen = init;
      return new Response('{}');
    });

    await wrapped('https://example.invalid/x', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'x-stainless-lang': 'js' },
    });

    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('{"a":1}');
  });

  it('headers 的三种形态都要认（Headers / 数组 / 普通对象）', async () => {
    for (const headers of [
      new Headers({ 'x-stainless-lang': 'js', Authorization: 'Bearer k' }),
      [['x-stainless-lang', 'js'], ['Authorization', 'Bearer k']] as [string, string][],
      { 'x-stainless-lang': 'js', Authorization: 'Bearer k' },
    ]) {
      const spy = spyFetch();
      await withCorsSafeHeaders(spy.fetch)('https://example.invalid/x', { headers });

      const h = spy.headersOf();
      expect(h.get('x-stainless-lang')).toBeNull();
      expect(h.get('authorization')).toBe('Bearer k');
    }
  });

  it('没有 headers 时原样放行，一个字段都不改', async () => {
    const calls: (RequestInit | undefined)[] = [];
    const inner: FetchLike = async (_input, init) => {
      calls.push(init);
      return new Response('{}');
    };
    await withCorsSafeHeaders(inner)('https://example.invalid/x', { method: 'GET' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'GET' });
  });

  it('没有可摘的头时不重建 init（别做无谓的拷贝）', async () => {
    const calls: (RequestInit | undefined)[] = [];
    const inner: FetchLike = async (_input, init) => {
      calls.push(init);
      return new Response('{}');
    };
    const init: RequestInit = { headers: { Authorization: 'Bearer k' } };
    await withCorsSafeHeaders(inner)('https://example.invalid/x', init);

    // 传下去的就是同一个对象（没有被拷贝过）
    expect(calls[0]).toBe(init);
  });

  it('★ 只认 x-stainless- 这一族，不做无差别清洗', async () => {
    const spy = spyFetch();
    await withCorsSafeHeaders(spy.fetch)('https://example.invalid/x', {
      headers: {
        'x-stainless-lang': 'js',
        'x-custom-header': 'keep-me',
        'x-request-id': 'keep-me-too',
      },
    });

    const h = spy.headersOf();
    expect(h.get('x-stainless-lang')).toBeNull();
    expect(h.get('x-custom-header')).toBe('keep-me');
    expect(h.get('x-request-id')).toBe('keep-me-too');
  });
});
