/**
 * 本地检索索引
 *
 * 产品文档第 9 节的「找得回来」：搜会话、板、AI 写的内容、你打的字、**截图**。
 *
 * ## 为什么是「在内存里扫一遍」而不是全文索引
 *
 * 技术文档 §9.6 的结论：**起步用最简单的关键词匹配就够了**。
 * 2 万条以内，逐条 `includes` 比任何索引都快、都简单，而且**中文完美** ——
 * 不需要分词、不需要维护索引一致性、离线可用、零依赖。
 *
 * （真要上 FTS5 的话中文有坑：默认分词器不切中文，trigram 又搜不了两字词。）
 *
 * 所以这里的做法是：把事件日志投影成一张「纯文本表」，缓存在内存里，
 * 事件变了就重建。几千条量级下重建是毫秒级的。
 *
 * ## 分层纪律
 *
 * 这个文件是**纯逻辑**：不碰 DOM、不碰 SQL。
 * HTML → 纯文本的转换通过 `toText` 注入进来（浏览器里用 DOMParser，
 * 测试里用一个简单的假实现）—— 这样核心逻辑能被完整测试。
 */

import type { BoardEvent } from './types';

export type SearchDocKind = 'board' | 'ai.write' | 'user.say' | 'snapshot';

export interface SearchDoc {
  /** 来源事件的 id */
  id: string;
  kind: SearchDocKind;
  boardId: string;
  /**
   * 这块板叫什么。
   *
   * ★ 检索是**跨全部板**的（产品文档 §9.5：「你搜『一元二次』，
   * 就把**所有**含这五个字的内容列出来」），所以结果列表里必须能看出
   * 每一条来自哪块板 —— 否则一列结果全是"不知道在哪"。
   */
  boardTitle: string;
  sessionId: string;
  /** 显示用的标题 */
  title: string;
  /** 纯文本正文 —— 搜索就在这里面找 */
  body: string;
  /** 区域名（AI 写的块才有），点结果时可以定位过去 */
  region: string | null;
  /** 附件 id（截图才有） */
  attachmentId: string | null;
  createdAt: number;
}

export interface BuildIndexInput {
  boardId: string;
  boardTitle: string;
  events: readonly BoardEvent[];
  /** HTML → 纯文本。注入进来是为了让这个文件保持纯净、可测试 */
  toText: (html: string) => string;
}


/** 把事件日志投影成可搜索的文档表 */
export function buildIndex(input: BuildIndexInput): SearchDoc[] {
  const docs: SearchDoc[] = [];

  for (const event of input.events) {
    if (event.boardId !== input.boardId) continue;

    const base = {
      id: event.id,
      boardId: event.boardId,
      boardTitle: input.boardTitle,
      sessionId: event.sessionId,
      createdAt: event.createdAt,
      region: null as string | null,
      attachmentId: null as string | null,
    };

    switch (event.kind) {
      case 'board.create':
        docs.push({ ...base, kind: 'board', title: '板的标题', body: event.payload.title });
        break;

      case 'ai.write': {
        const { op } = event.payload;
        if (op === 'remove') break; // 已经删掉的内容不该被搜出来
        const html = event.payload.html ?? '';
        const region = 'region' in event.payload ? (event.payload.region ?? null) : null;
        docs.push({
          ...base,
          kind: 'ai.write',
          title: region ?? '板面内容',
          body: input.toText(html),
          region,
        });
        break;
      }

      case 'user.say':
        docs.push({ ...base, kind: 'user.say', title: '你说的', body: event.payload.text });
        break;

      case 'board.snapshot':
        docs.push({
          ...base,
          kind: 'snapshot',
          title: '截图',
          // ★ 截图能被搜到，全靠这一行：图说（caption）+ 你当时打的那句话
          //   （图说是 M4 用视觉模型生成的，见技术文档 §9.5）
          body: [event.payload.caption ?? '', event.payload.text ?? ''].join(' ').trim(),
          attachmentId: event.payload.attachmentId,
        });
        break;

      default:
        // 笔迹、选项、记忆这些不进检索索引 —— 要么没有文字，要么没意义
        break;
    }
  }

  return docs;
}

export interface SearchHit extends SearchDoc {
  score: number;
}

/**
 * 关键词检索。
 *
 * 就是朴素的子串匹配 —— 但这正是它适合中文的原因：**不需要分词**。
 * 「判别式」这三个字直接找，不会因为分词器不认识它而漏掉。
 */
export function search(
  index: readonly SearchDoc[],
  query: string,
  limit = 50,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];

  const hits: SearchHit[] = [];

  for (const doc of index) {
    const title = doc.title.toLowerCase();
    const body = doc.body.toLowerCase();

    let score = 0;

    // 标题命中比正文命中重要得多（「判别式」作为区域名 vs 正文里提了一句）
    if (title.includes(q)) score += 100;

    const bodyAt = body.indexOf(q);
    if (bodyAt !== -1) {
      score += 10;
      // 出现得越靠前，越可能是这条在讲的重点
      if (bodyAt < 40) score += 5;
    }

    if (score === 0) continue;

    // 同一个词出现多次，稍微加权（但设上限，避免一条长文把其它结果全压掉）
    let occurrences = 0;
    let from = 0;
    for (;;) {
      const at = body.indexOf(q, from);
      if (at === -1) break;
      occurrences += 1;
      from = at + q.length;
      if (occurrences >= 5) break;
    }
    score += occurrences;

    hits.push({ ...doc, score });
  }

  // 分高的在前；同分时新的在前
  hits.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
  return hits.slice(0, limit);
}
/**
 * 只保留每个区域**最后生效**的那一版。
 *
 * 因为 `set` 会替换同区域的内容。如果直接按事件顺序投影，被替换掉的旧内容
 * 仍然留在索引里 —— 用户会搜到一段**板上已经不存在的文字**，点过去还找不到。
 */
export function dedupeByRegion(docs: readonly SearchDoc[]): SearchDoc[] {
  const latestByRegion = new Map<string, SearchDoc>();
  const kept: SearchDoc[] = [];

  for (const doc of docs) {
    if (doc.kind !== 'ai.write' || doc.region === null) {
      kept.push(doc);
      continue;
    }
    const previous = latestByRegion.get(doc.region);
    if (previous !== undefined) {
      // 把之前那条同区域的旧版本挤掉
      const at = kept.indexOf(previous);
      if (at !== -1) kept.splice(at, 1);
    }
    latestByRegion.set(doc.region, doc);
    kept.push(doc);
  }

  return kept;
}
