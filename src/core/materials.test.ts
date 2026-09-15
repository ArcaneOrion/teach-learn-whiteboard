/**
 * 资料切块与检索的测试
 *
 * 检索质量很难「断言正确」，所以这里测的是**性质**而不是具体分数：
 *   · 相关段落必须排在无关段落前面
 *   · 完全无关的查询必须返回空（宁可不给，也别拿噪声污染上下文）
 *   · 切块不能把一句话切断（那是检索质量的根基）
 */

import { describe, expect, it } from 'vitest';

import {
  bigrams,
  chunkText,
  MIN_SCORE,
  scoreText,
  searchMaterials,
  type MaterialCandidate,
} from './materials';

describe('chunkText', () => {
  it('短文本就是一块', () => {
    const chunks = chunkText('就一句话。');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('就一句话。');
  });

  it('空文本切不出东西', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('★ 按目标字数攒够一段就收，但**不切断段落**', () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `第${i}段。${'内容'.repeat(60)}`);
    const whole = new Set(paragraphs);
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, { targetChars: 300, maxChars: 600 });

    expect(chunks.length).toBeGreaterThan(1);

    // ★ 直接断言「没切断段落」：每块拆开之后，每一段都能在原文里原样找到
    for (const chunk of chunks) {
      for (const part of chunk.text.split('\n\n')) {
        expect(whole.has(part), `这一块里有被切断的段落：${part.slice(0, 20)}…`).toBe(true);
      }
    }

    // 拼回去内容不丢
    const joined = chunks.map((c) => c.text).join('');
    for (const p of paragraphs) {
      expect(joined).toContain(p);
    }
  });

  it('★ 单个超长段落会被切开，而且尽量切在句末', () => {
    const sentence = '这是一句话，用来测试超长段落的切分。';
    const body = sentence.repeat(40); // 约 760 字
    const chunks = chunkText(body, { targetChars: 200, maxChars: 250 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(250);
    }
  });

  it('Markdown 标题会成为后续块的 heading', () => {
    const text = ['# 一元二次方程', '', '第一段内容。', '', '## 判别式', '', '判别式的内容。'].join('\n');
    const chunks = chunkText(text, { targetChars: 20, maxChars: 40 });

    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('一元二次方程');
    expect(headings).toContain('判别式');
  });

  it('记住每块在原文里的位置', () => {
    const text = 'AAAA\n\nBBBB\n\nCCCC';
    const chunks = chunkText(text, { targetChars: 5, maxChars: 10 });
    for (const chunk of chunks) {
      expect(chunk.start).toBeGreaterThanOrEqual(0);
      expect(chunk.end).toBeGreaterThanOrEqual(chunk.start);
      expect(text.slice(chunk.start, chunk.start + 4)).toBe(chunk.text.slice(0, 4));
    }
  });

  it('切出来的块不超过上限（除非单句本身就超长）', () => {
    const text = Array.from({ length: 20 }, (_, i) => `第 ${i} 段。`).join('\n\n');
    for (const chunk of chunkText(text, { targetChars: 40, maxChars: 80 })) {
      expect(chunk.text.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('bigrams', () => {
  it('去掉空白再取两字组合', () => {
    expect([...bigrams('一二三')].sort()).toEqual(['一二', '二三']);
    expect([...bigrams('一 二 三')].sort()).toEqual(['一二', '二三']);
  });

  it('太短的文本没有二元组', () => {
    expect(bigrams('一').size).toBe(0);
    expect(bigrams('').size).toBe(0);
  });
});

describe('scoreText', () => {
  it('原句出现 → 分数最高', () => {
    const text = '判别式 Δ = b² − 4ac 决定根的个数。';
    expect(scoreText('判别式 Δ = b² − 4ac 决定根的个数。', text)).toBeGreaterThan(1);
  });

  it('★ 一整句话的查询也能命中（这是不能用子串匹配的原因）', () => {
    const text = '判别式 Δ = b² − 4ac 决定根的个数，大于零有两个不相等的实根。';
    // 拿整句去 includes 是匹配不到的，但二元组能
    expect(text.includes('判别式是怎么决定根的')).toBe(false);
    expect(scoreText('判别式是怎么决定根的', text)).toBeGreaterThan(MIN_SCORE);
  });

  it('完全无关的查询得 0 分', () => {
    expect(scoreText('三角函数余弦定理', '判别式 Δ = b² − 4ac 决定根的个数。')).toBe(0);
  });

  it('空查询得 0 分', () => {
    expect(scoreText('', '随便什么')).toBe(0);
    expect(scoreText('   ', '随便什么')).toBe(0);
  });

  it('单字查询退回子串匹配（不崩）', () => {
    expect(scoreText('根', '有两个实根')).toBeGreaterThan(0);
    expect(scoreText('猫', '有两个实根')).toBe(0);
  });

  it('英文也认（大小写不敏感）', () => {
    expect(scoreText('Discriminant', 'the discriminant decides roots')).toBeGreaterThan(MIN_SCORE);
  });
});

describe('searchMaterials', () => {
  const candidates: MaterialCandidate[] = [
    {
      chunkId: 'c1', docId: 'd1', docTitle: '代数课本', heading: '判别式',
      text: '判别式 Δ = b² − 4ac 决定一元二次方程根的个数。大于零有两个不相等的实根，等于零有两个相等的实根，小于零没有实根。',
    },
    {
      chunkId: 'c2', docId: 'd1', docTitle: '代数课本', heading: '求根公式',
      text: '一元二次方程的求根公式是 x = (−b ± √(b²−4ac)) / 2a，其中根号里就是判别式。',
    },
    {
      chunkId: 'c3', docId: 'd2', docTitle: '英语单词本', heading: null,
      text: 'discriminant 形容词：有识别力的。',
    },
    {
      chunkId: 'c4', docId: 'd2', docTitle: '地理笔记', heading: null,
      text: '季风气候的成因与海陆热力性质差异有关。',
    },
  ];

  it('★ 相关段落排在前面', () => {
    const hits = searchMaterials(candidates, '判别式');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunkId).toBe('c1');
  });

  it('★ 整句提问也能找到对应段落', () => {
    const hits = searchMaterials(candidates, '一元二次方程的求根公式是什么');
    expect(hits.map((h) => h.chunkId)).toContain('c2');
  });

  it('★ 完全无关的问题返回空 —— 宁可不给，也别拿噪声污染上下文', () => {
    expect(searchMaterials(candidates, '怎么做红烧肉')).toEqual([]);
  });

  it('limit 生效，而且按分数从高到低', () => {
    const hits = searchMaterials(candidates, '判别式 求根公式', 1);
    expect(hits).toHaveLength(1);

    const all = searchMaterials(candidates, '判别式 求根公式');
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i - 1]!.score).toBeGreaterThanOrEqual(all[i]!.score);
    }
  });

  it('结果带上出处（文档名 + 标题），因为要写到板上给用户看', () => {
    const hit = searchMaterials(candidates, '判别式')[0];
    expect(hit?.docTitle).toBe('代数课本');
    expect(hit?.heading).toBe('判别式');
    expect(hit?.docId).toBe('d1');
  });

  it('没有资料时返回空', () => {
    expect(searchMaterials([], '随便问')).toEqual([]);
  });
});
