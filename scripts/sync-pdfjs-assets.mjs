#!/usr/bin/env node
/**
 * 把 pdfjs 需要的静态资源复制到 public/ 下
 *
 * ## 为什么必须做这一步
 *
 * pdf.js 解析 **中文 PDF** 时要靠 CMap 文件把字体里的 CID 编码映射回 Unicode。
 * 不带这些文件的话，很多中文书的文字**根本抽不出来** ——
 * 而且它不会报错，只是抽出来是空的或者一串乱码。
 * （西方字体的 PDF 一般不需要，所以"我拿英文 PDF 试是好的"会骗过你。）
 *
 * 两份资源：
 *   · cmaps/          169 个 CMap，中文（GB / CNS）、日文、韩文都靠它
 *   · standard_fonts/ 16 个标准字体，处理没内嵌字体的 PDF
 *
 * ## 为什么不提交进 git
 *
 * 一共 2.5 MB 的第三方二进制资源，每次 `pnpm install` 都能重新生成。
 * 所以放在 `public/pdfjs/` 并加进 .gitignore，由 dev / build 前自动复制。
 *
 * 用法：node scripts/sync-pdfjs-assets.mjs [--force]
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/pdfjs-dist');
const target = resolve(root, 'public/pdfjs');

const PIECES = ['cmaps', 'standard_fonts'];

const force = process.argv.includes('--force');

if (!existsSync(source)) {
  console.error('找不到 node_modules/pdfjs-dist —— 先跑 pnpm install');
  process.exit(1);
}

/** 已经复制过就跳过（dev 每次启动都跑一遍脚本，不该每次都拷 2.5MB） */
function looksDone() {
  for (const piece of PIECES) {
    const dir = resolve(target, piece);
    if (!existsSync(dir) || statSync(dir).size === 0) return false;
  }
  return true;
}

if (!force && looksDone()) {
  console.log('pdfjs 静态资源已就绪，跳过复制');
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let total = 0;
for (const piece of PIECES) {
  const from = resolve(source, piece);
  if (!existsSync(from)) {
    console.warn(`⚠️ 少了 ${piece}，跳过（中文 PDF 可能会抽不出文字）`);
    continue;
  }
  cpSync(from, resolve(target, piece), { recursive: true });
  total += 1;
}

console.log(`已复制 ${total} 份 pdfjs 静态资源到 public/pdfjs/`);
