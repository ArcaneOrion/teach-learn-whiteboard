/**
 * 版本号脚本的测试
 *
 * 这类脚本最危险的失败**不是崩掉**，而是**改了等于没改**：
 * 正则没匹配上、悄悄返回原文，然后 APK 名字是新的、里面还是旧版本 ——
 * 表现成「我明明装了新版怎么还是老样子」，能查半天。
 *
 * 所以这里重点盯两件事：
 *   ① 认不出来时必须**抛错**，不能沉默
 *   ② versionCode 必须**严格单调递增**（不递增安卓会拒装）
 */

import { describe, expect, it } from 'vitest';

import { bumpPatch, stampGradle, stampMainTs, stampPackageJson, toVersionCode } from './version.mjs';

describe('bumpPatch', () => {
  it('只动最后一位', () => {
    expect(bumpPatch('0.1.0')).toBe('0.1.1');
    expect(bumpPatch('0.1.9')).toBe('0.1.10'); // 不是 0.2.0
    expect(bumpPatch('2.3.99')).toBe('2.3.100');
  });

  it('进位不会串到前面', () => {
    expect(bumpPatch('0.1.99')).toBe('0.1.100');
  });

  it('格式不对要抛错，不能瞎猜', () => {
    expect(() => bumpPatch('1.0')).toThrow();
    expect(() => bumpPatch('v1.0.0')).toThrow();
  });
});

describe('toVersionCode', () => {
  it('同一个版本永远算出同一个数', () => {
    expect(toVersionCode('0.1.0')).toBe(10_000);
    expect(toVersionCode('0.1.1')).toBe(10_001);
  });

  it('★ 严格单调递增 —— 不递增安卓会当降级、直接拒装', () => {
    const versions = ['0.1.0', '0.1.1', '0.1.2', '0.2.0', '0.9.9', '1.0.0'];
    const codes = versions.map(toVersionCode);
    for (let i = 1; i < codes.length; i += 1) {
      expect(codes[i]).toBeGreaterThan(codes[i - 1]);
    }
  });

  it('★ 次版本进位不能和补丁号撞车', () => {
    // 曾经想用 minor*100+patch，那样 0.1.100 和 0.2.0 会撞成同一个数
    expect(toVersionCode('0.1.100')).not.toBe(toVersionCode('0.2.0'));
    expect(toVersionCode('0.2.0')).toBeGreaterThan(toVersionCode('0.1.100'));
  });

  it('大到离谱也要抛错，不能静默溢出安卓的上限', () => {
    expect(() => toVersionCode('9999.0.0')).toThrow();
  });
});

describe('stampGradle', () => {
  const sample = [
    '    defaultConfig {',
    '        applicationId "com.arcaneorion.whiteboard"',
    '        versionCode 1',
    '        versionName "0.1.0"',
    '    }',
  ].join('\n');

  it('versionName 和 versionCode 一起写', () => {
    const out = stampGradle(sample, '0.1.5');
    expect(out).toContain('versionName "0.1.5"');
    expect(out).toContain('versionCode 10005');
  });

  it('别的东西一个都不许动', () => {
    const out = stampGradle(sample, '0.1.5');
    expect(out).toContain('applicationId "com.arcaneorion.whiteboard"');
    expect(out.split('\n')).toHaveLength(sample.split('\n').length);
  });

  it('★ 结构变了要抛错 —— 悄悄返回原文就等于「改了等于没改」', () => {
    expect(() => stampGradle('android {\n}', '0.1.5')).toThrow(/versionCode/);
    expect(() => stampGradle('versionCode 1\n', '0.1.5')).toThrow(/versionName/);
  });
});

describe('stampMainTs', () => {
  it('只换版本字符串', () => {
    const src = `const APP_VERSION = '0.1.0';\nconst other = '0.1.0';`;
    const out = stampMainTs(src, '0.1.7');
    expect(out).toContain(`const APP_VERSION = '0.1.7';`);
    // 别的同值字符串不能被误伤
    expect(out).toContain(`const other = '0.1.0';`);
  });

  it('★ 找不到那一行要抛错', () => {
    expect(() => stampMainTs('const X = 1;', '0.1.7')).toThrow(/APP_VERSION/);
  });
});

describe('stampPackageJson', () => {
  it('只动 version，缩进和字段顺序原样保留', () => {
    const src = '{\n  "name": "x",\n  "version": "0.1.0",\n  "private": true\n}\n';
    const out = stampPackageJson(src, '0.1.2');
    expect(out).toBe('{\n  "name": "x",\n  "version": "0.1.2",\n  "private": true\n}\n');
  });

  it('★ 没有 version 字段要抛错', () => {
    expect(() => stampPackageJson('{ "name": "x" }', '0.1.2')).toThrow(/version/);
  });
});
