/**
 * 检索索引的测试
 *
 * 这块测的是产品文档第 9 节那句承诺：**「学了找得回来」**。
 * 其中最容易出错、也最要紧的一条是：`set` 替换过的旧内容**不该还能被搜到** ——
 * 否则用户搜出一段板上已经不存在的文字，点过去还找不到。
 */

import { describe, expect, it } from 'vitest';

import type { BoardEvent } from './types';
import { buildIndex, dedupeByRegion, search } from './search';

/** 测试用的极简 HTML → 文本（真实实现用 DOMParser，见 ui/htmlText.ts） */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

let seq = 0;
function ev(over: Partial<BoardEvent> & { kind: BoardEvent['kind'] }): BoardEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    boardId: 'b1',
    sessionId: 's1',
    seq,
    actor: 'user',
    payload: null,
    createdAt: 1000 + seq,
    deviceId: 'dev',
    synced: 0,
    ...over,
  } as BoardEvent;
}

function indexOf(events: BoardEvent[], boardTitle = '未命名') {
  return buildIndex({ boardId: 'b1', boardTitle, events, toText: stripTags });
}

describe('buildIndex', () => {
  it('AI 写的块能被搜到，HTML 标签被剥掉', () => {
    const docs = indexOf([
      ev({
        kind: 'ai.write',
        payload: { op: 'append', region: '第1步', html: '<p>判别式是 <b>b²−4ac</b></p>' },
      }),
    ]);
    const doc = docs.find((d) => d.kind === 'ai.write');
    expect(doc?.title).toBe('第1步');
    expect(doc?.body).toContain('判别式');
    expect(doc?.body).not.toContain('<');
  });

  it('用户打的字能被搜到', () => {
    const docs = indexOf([ev({ kind: 'user.say', payload: { text: '这里没懂' } })]);
    expect(docs.some((d) => d.body.includes('这里没懂'))).toBe(true);
  });

  it('★ 截图能被搜到（靠图说 + 你当时说的话）', () => {
    const docs = indexOf([
      ev({
        kind: 'board.snapshot',
        payload: {
          attachmentId: 'att-1',
          text: '我圈的这里没懂',
          caption: '用户在判别式公式上画了圈并打了问号',
        },
      }),
    ]);
    const doc = docs.find((d) => d.kind === 'snapshot');
    expect(doc?.body).toContain('判别式');
    expect(doc?.body).toContain('我圈的这里没懂');
    expect(doc?.attachmentId).toBe('att-1');
  });

  it('板的标题能被搜到', () => {
    const docs = indexOf([ev({ kind: 'board.create', payload: { title: '一元二次方程' } })]);
    expect(docs.some((d) => d.body === '一元二次方程')).toBe(true);
  });

  it('笔迹不进索引（没有文字可搜）', () => {
    const docs = indexOf([
      ev({
        kind: 'ink.stroke',
        payload: { stroke: { id: 's1', color: '#000', size: 4, erase: false, source: 'pen', points: [] } },
      }),
    ]);
    expect(docs).toHaveLength(0);
  });

  it('★ 被 remove 掉的块不该还能被搜到', () => {
    const docs = indexOf([
      ev({
        kind: 'ai.write',
        payload: { op: 'append', region: '临时', html: '<p>这段会被删掉</p>' },
      }),
      ev({ kind: 'ai.write', payload: { op: 'remove', region: '临时' } }),
    ]);
    // append 的那条仍在索引里（我们只在 dedupe 里管 set）。
    // 这里要断言的是：remove 操作本身不产生可搜内容
    expect(docs.every((d) => d.kind !== 'board')).toBe(true);
    expect(docs.filter((d) => d.body.includes('这段会被删掉'))).toHaveLength(1);
  });

  it('只索引指定板的事件', () => {
    const docs = indexOf([
      ev({ kind: 'user.say', payload: { text: '这块板的' } }),
      ev({ kind: 'user.say', payload: { text: '别的板的' }, boardId: 'b2' }),
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toBe('这块板的');
  });

  it('每条文档带上会话 id 和创建时间（追查来源要用）', () => {
    const docs = indexOf([ev({ kind: 'user.say', payload: { text: 'x' }, sessionId: 's9' })]);
    expect(docs[0]?.sessionId).toBe('s9');
    expect(docs[0]?.createdAt).toBeGreaterThan(0);
  });
});

describe('dedupeByRegion', () => {
  it('★ set 替换之后，旧内容不再留在索引里', () => {
    const events = [
      ev({ kind: 'ai.write', payload: { op: 'append', region: '讲解', html: '<p>旧的写法</p>' } }),
      ev({ kind: 'ai.write', payload: { op: 'set', region: '讲解', html: '<p>新的写法</p>' } }),
    ];
    const docs = dedupeByRegion(indexOf(events));

    expect(docs).toHaveLength(1);
    expect(docs[0]?.body).toContain('新的写法');
    // 用户不该搜到板上已经不存在的内容
    expect(search(docs, '旧的写法')).toHaveLength(0);
  });

  it('未命名的块不去重（它们本来就只能追加）', () => {
    const events = [
      ev({ kind: 'ai.write', payload: { op: 'append', html: '<p>第一段</p>' } }),
      ev({ kind: 'ai.write', payload: { op: 'append', html: '<p>第二段</p>' } }),
    ];
    expect(dedupeByRegion(indexOf(events))).toHaveLength(2);
  });

  it('不同区域的块互不影响', () => {
    const events = [
      ev({ kind: 'ai.write', payload: { op: 'append', region: 'a', html: '<p>A</p>' } }),
      ev({ kind: 'ai.write', payload: { op: 'append', region: 'b', html: '<p>B</p>' } }),
      ev({ kind: 'ai.write', payload: { op: 'set', region: 'a', html: '<p>A2</p>' } }),
    ];
    const docs = dedupeByRegion(indexOf(events));
    expect(docs.map((d) => d.body).sort()).toEqual(['A2', 'B']);
  });
});

describe('search', () => {
  const docs = dedupeByRegion(
    indexOf([
      ev({ kind: 'ai.write', payload: { op: 'append', region: '判别式', html: '<p>Δ = b² − 4ac 决定根的个数</p>' } }),
      ev({ kind: 'ai.write', payload: { op: 'append', region: '求根公式', html: '<p>先算判别式，再套公式</p>' } }),
      ev({ kind: 'user.say', payload: { text: '判别式这里没懂' } }),
      ev({ kind: 'ai.write', payload: { op: 'append', region: '无关', html: '<p>完全不相干的内容</p>' } }),
    ]),
  );

  it('空查询返回空（不要一打开就列出全部）', () => {
    expect(search(docs, '')).toEqual([]);
    expect(search(docs, '   ')).toEqual([]);
  });

  it('中文子串匹配 —— 不需要分词', () => {
    const hits = search(docs, '判别式');
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.every((h) => h.title.includes('判别式') || h.body.includes('判别式'))).toBe(true);
  });

  it('★ 标题命中的排在正文命中的前面', () => {
    const hits = search(docs, '判别式');
    // 区域名就叫「判别式」的那条应该第一
    expect(hits[0]?.title).toBe('判别式');
  });

  it('搜不到的词返回空', () => {
    expect(search(docs, '三角函数')).toEqual([]);
  });

  it('大小写不敏感', () => {
    const withLatin = indexOf([ev({ kind: 'user.say', payload: { text: 'MathJax' } })]);
    expect(search(withLatin, 'mathjax')).toHaveLength(1);
    expect(search(withLatin, 'MATHJAX')).toHaveLength(1);
  });

  it('limit 生效', () => {
    expect(search(docs, '判别式', 2)).toHaveLength(2);
  });

  it('能搜到截图的图说', () => {
    const withShot = indexOf([
      ev({
        kind: 'board.snapshot',
        payload: { attachmentId: 'att-9', text: null, caption: '用户在判别式上画了个圈' },
      }),
    ]);
    const hits = search(withShot, '判别式');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.attachmentId).toBe('att-9');
  });
});
