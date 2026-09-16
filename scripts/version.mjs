#!/usr/bin/env node
/**
 * 版本号的唯一来源是 `package.json` 的 `version`。
 *
 * 但一个版本号其实写在**三个地方**，而它们必须一致：
 *
 *   package.json                      版本（唯一来源）
 *   android/app/build.gradle          versionName + versionCode（安卓系统认这个）
 *   src/main.ts 的 APP_VERSION        导出备份时写进文件里
 *
 * 三处手改必然有一天会不一致 —— 而且不一致了**不会有任何报错**，
 * 只会在某次装包时出现「为什么手机上显示的还是上一版」这种玄学问题。
 * 所以用一个脚本刷，别手改。
 *
 * 用法：
 *   node scripts/version.mjs sync    把 package.json 的版本刷到另外两处
 *   node scripts/version.mjs bump    补丁号 +1，再刷（打包时默认走这个）
 *   node scripts/version.mjs show    只打印当前版本
 *
 * 结构上把「怎么改文本」做成纯函数、和读写文件分开 ——
 * 这样「正则没匹配上」这种最危险的失败（改了等于没改，但没人报错）
 * 才有办法写测试盯住。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const FILES = {
  packageJson: join(ROOT, 'package.json'),
  buildGradle: join(ROOT, 'android/app/build.gradle'),
  mainTs: join(ROOT, 'src/main.ts'),
};

/** 补丁号 +1：0.1.3 → 0.1.4。主/次版本号要人来定，脚本只动最后一位 */
export function bumpPatch(version) {
  const parts = parse(version);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function parse(version) {
  const parts = String(version).split('.');
  if (parts.length !== 3) throw new Error(`版本号得是 x.y.z 三段，现在是「${version}」`);
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`版本号里有不是数字的段：「${version}」`);
  }
  return nums;
}

const MINOR_LIMIT = 100;
const PATCH_LIMIT = 10000;

/**
 * 版本名 → versionCode（安卓判断新旧的整数）。
 *
 * 必须**单调递增**：不递增会被系统当成降级、直接拒装。
 *
 * ⚠️ 用定宽十进制（minor 占 4 位、patch 占 4 位），别用 `minor*100+patch`
 * 那种写法 —— 那样 patch 一超过 99 就和下一个 minor 撞车
 * （0.1.100 和 0.2.0 会算出同一个数），而撞车之后版本序就乱了，
 * 偏偏这种错一年也遇不上一次，遇上了又极难查。
 */
export function toVersionCode(version) {
  const [major, minor, patch] = parse(version);
  if (minor >= MINOR_LIMIT) throw new Error(`次版本号不能到 ${MINOR_LIMIT}：${version}`);
  if (patch >= PATCH_LIMIT) throw new Error(`补丁号不能到 ${PATCH_LIMIT}：${version}`);
  const code = major * 1_000_000 + minor * 10_000 + patch;
  if (code > 2_100_000_000) throw new Error(`versionCode 超出安卓上限：${code}`);
  return code;
}

// ── 三个「改文本」的纯函数 ────────────────────────────────────
// 统一约定：改不动就**抛错**，绝不悄悄返回原文 ——
// 那正是「改了等于没改」的来源。

/** build.gradle：同时写 versionCode 和 versionName */
export function stampGradle(text, version) {
  const code = toVersionCode(version);

  if (!/versionCode\s+\d+/.test(text)) throw new Error('build.gradle 里找不到 versionCode 那一行');
  if (!/versionName\s+"[^"]*"/.test(text)) throw new Error('build.gradle 里找不到 versionName 那一行');

  return text
    .replace(/versionCode\s+\d+/, `versionCode ${code}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
}

/** main.ts：导出备份时写进文件里的那个版本 */
export function stampMainTs(text, version) {
  if (!/const APP_VERSION = '[^']*';/.test(text)) {
    throw new Error('main.ts 里找不到 APP_VERSION 那一行');
  }
  return text.replace(/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${version}';`);
}

/** package.json：只动 version 字段，别碰别的（缩进、字段顺序都要原样保留） */
export function stampPackageJson(text, version) {
  if (!/"version"\s*:\s*"[^"]*"/.test(text)) {
    throw new Error('package.json 里找不到 version 字段');
  }
  return text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}

// ── 读写（薄壳）────────────────────────────────────────────────

export function readVersion() {
  return JSON.parse(readFileSync(FILES.packageJson, 'utf8')).version;
}

/** 把版本刷到三个文件。返回实际写进去的版本号 */
export function stamp(version) {
  const plan = [
    [FILES.buildGradle, stampGradle],
    [FILES.mainTs, stampMainTs],
    [FILES.packageJson, stampPackageJson],
  ];

  for (const [path, fn] of plan) {
    const before = readFileSync(path, 'utf8');
    const after = fn(before, version);
    if (after !== before) writeFileSync(path, after);
  }
  return version;
}

// ── 命令行 ────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? 'show';

  if (cmd === 'show') {
    console.log(readVersion());
  } else if (cmd === 'sync') {
    const v = stamp(readVersion());
    console.log(`已把版本 ${v} 刷到 build.gradle 和 main.ts`);
  } else if (cmd === 'bump') {
    const v = bumpPatch(readVersion());
    stamp(v);
    console.log(`版本 → ${v}（versionCode ${toVersionCode(v)}）`);
  } else {
    console.error(`不认识的命令：${cmd}\n用法：sync | bump | show`);
    process.exit(1);
  }
}
