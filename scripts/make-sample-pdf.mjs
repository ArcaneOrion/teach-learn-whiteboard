#!/usr/bin/env node
/**
 * 生成一个测试用的 PDF
 *
 * 为什么自己造而不是找现成的：
 *   · 机器上的 PDF 是用户的私人文档，**不该拿来当测试数据**
 *   · 自己造的可以精确控制内容（几页、每页有什么字），断言才写得准
 *
 * 这个脚本手写了一个**最小但完全合法**的 PDF：不压缩、内嵌标准字体，
 * 任何解析器都应该能读出文字。用法：
 *
 *   node scripts/make-sample-pdf.mjs .artifacts/sample.pdf
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** PDF 的字符串里这几个字符要转义 */
function escapeText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * @param pages 每页若干行文字
 */
export function buildPdf(pages) {
  const objects = [];

  // 1 = Catalog，2 = Pages，3..  = 每页的 Page / Contents 对象
  const pageObjectIds = [];
  let nextId = 3;

  for (let i = 0; i < pages.length; i += 1) {
    pageObjectIds.push({ page: nextId, content: nextId + 1 });
    nextId += 2;
  }

  const fontId = nextId;
  nextId += 1;

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';

  const kids = pageObjectIds.map((p) => `${p.page} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;

  for (let i = 0; i < pages.length; i += 1) {
    const ids = pageObjectIds[i];
    const lines = pages[i];

    // 每行是一条 Tj，从页面顶部往下排
    const body =
      'BT\n/F1 12 Tf\n14 TL\n72 720 Td\n' +
      lines.map((line) => `(${escapeText(line)}) Tj\nT*`).join('\n') +
      '\nET';

    objects[ids.page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${ids.content} 0 R >>`;
    objects[ids.content] = `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  }

  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  // ── 拼文件，同时记下每个对象的字节偏移 ──────────────────────
  let out = '%PDF-1.4\n';
  const offsets = [];

  for (let id = 1; id < nextId; id += 1) {
    if (objects[id] === undefined) continue;
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${nextId}\n`;
  out += '0000000000 65535 f \n';
  for (let id = 1; id < nextId; id += 1) {
    const offset = offsets[id];
    if (offset === undefined) {
      // 空槽也要占一行，格式不能乱
      out += '0000000000 65535 f \n';
    } else {
      out += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
  }

  out += `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}

// 直接运行时写一个样例文件
if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const target = resolve(process.argv[2] ?? '.artifacts/sample.pdf');
  mkdirSync(dirname(target), { recursive: true });

  const pdf = buildPdf([
    ['Quadratic Equations', 'Standard form: ax^2 + bx + c = 0 (a != 0)', 'The discriminant decides the number of roots.'],
    ['Discriminant', 'Delta = b^2 - 4ac', 'If Delta > 0 there are two distinct real roots.', 'If Delta = 0 there are two equal real roots.'],
    ['Quadratic Formula', 'x = (-b +- sqrt(b^2 - 4ac)) / 2a', 'Compute the discriminant first, then apply the formula.'],
  ]);

  writeFileSync(target, pdf);
  console.log(`已生成 ${target}（${pdf.length} 字节，3 页）`);
}
