/**
 * 错误翻译的测试
 *
 * 这块值得测，因为它防的是**用户看到一句完全无用的报错**：
 * 浏览器把 CORS 失败报成 `Failed to fetch`，不翻译的话
 * 用户只会以为"这 App 坏了"，而不是"这家渠道不能在浏览器里用"。
 */

import { describe, expect, it } from 'vitest';

import { explainError } from './errors';

describe('explainError', () => {
  it('★ 浏览器里的 Failed to fetch 要说清 CORS 这回事', () => {
    const msg = explainError(new TypeError('Failed to fetch'), 'browser');
    expect(msg).toContain('CORS');
    expect(msg).toContain('装到手机上');
  });

  // ★ 这条字符串是**实测抓到的**：pi-ai 把浏览器里被 CORS 挡住的请求
  //   包装成了 "Connection error." 抛出来（技术文档 §7.3）
  it('★ pi-ai 包装过的 "Connection error." 也要说清 CORS', () => {
    expect(explainError(new Error('模型调用出错：Connection error.'), 'browser')).toContain('CORS');
    expect(explainError(new Error('模型调用出错：Connection error.'), 'app')).not.toContain('CORS');
  });

  it('各种网络类报错都归到「连接失败」', () => {
    for (const raw of [
      'Failed to fetch',
      'NetworkError when attempting to fetch resource',
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:11434',
      'getaddrinfo ENOTFOUND api.example.invalid',
      'socket hang up',
    ]) {
      expect(explainError(new Error(raw))).toContain('连接失败');
    }
  });

  it('★ 装在手机上时不再提 CORS（那时候根本不存在这个问题）', () => {
    const msg = explainError(new TypeError('Failed to fetch'), 'app');
    expect(msg).not.toContain('CORS');
    expect(msg).toContain('Base URL');
  });

  // ★ 下面这些字符串是**实测抓到的真实报错**（技术文档 §7.3 的 CORS 探测），
  //   不是编出来的。各家的措辞完全不一样，所以不能只认 "401" 这一个词。
  it('★ 各家的真实鉴权报错都能认出来', () => {
    const REAL = [
      ['DeepSeek', '{"error":{"message":"Authentication Fails, Your api key: ****robe is invalid","type":"authentication_error"}}'],
      ['硅基流动', '{"code":30014,"data":null,"message":"Token is invalid."}'],
      ['智谱', '{"error":{"code":"401","message":"token expired or incorrect"}}'],
      ['通义', '{"error":{"message":"Incorrect API key provided. For details, see: ..."}}'],
      ['Anthropic', '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
      ['通用', 'HTTP 401'],
      ['通用', 'Request failed with status 401'],
      ['通用', 'Unauthorized'],
    ] as const;

    for (const [who, raw] of REAL) {
      expect(explainError(new Error(raw)), `${who} 的报错应该被认出来：${raw}`).toContain('Key 不对');
    }
  });

  it('403 / 404 / 429 / 5xx 各自有话说', () => {
    expect(explainError(new Error('403 Forbidden'))).toContain('403');
    expect(explainError(new Error('model not found'))).toContain('模型 ID');
    expect(explainError(new Error('429 Too Many Requests'))).toContain('限流');
    expect(explainError(new Error('502 Bad Gateway'))).toContain('厂商那边出错');
  });

  it('取消有单独的说法', () => {
    expect(explainError(new Error('The operation was aborted'))).toContain('取消');
  });

  it('不认识的原样返回，不吞掉信息', () => {
    const raw = '某种我们从没见过的错误 xyz';
    expect(explainError(new Error(raw))).toBe(raw);
  });

  it('非 Error 的输入也能处理', () => {
    expect(explainError('Failed to fetch')).toContain('连接失败');
    expect(explainError({ weird: true })).toBeTypeOf('string');
    expect(explainError(null)).toBeTypeOf('string');
    expect(explainError(undefined)).toBeTypeOf('string');
  });

  it('JSON 形式的厂商报错也能认出来', () => {
    const raw = '{"error":{"code":"401","message":"token expired or incorrect"}}';
    expect(explainError(new Error(raw))).toContain('Key 不对');
  });
});
