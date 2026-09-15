/**
 * 资料切块与检索（M7 / RAG）
 *
 * ## 产品定位（产品文档 §13）
 *
 * **RAG 是「让 AI 去检索你上传的文件」，不是「把整本书塞进上下文」。**
 * 所以流程是：导入 → 切块 → 存起来 →（回答时）按需检索 → **把查到的段落写到板上**。
 *
 * ## ⚠️ 检索为什么不是简单的子串匹配
 *
 * core/search.ts（学习记录的检索）用的是子串匹配，因为那里的查询是**关键词**
 * （用户搜「判别式」）。但 RAG 的查询是**一整句话** —— 「判别式的求根公式是怎么来的」。
 * 拿整句去 `includes`，几乎什么都匹配不到。
 *
 * 也不能靠分词：中文没有空格，而 FTS5 默认分词器不切中文（技术文档 §9.6 踩过）。
 *
 * 这里用的是**字符二元组（bigram）重合度**：
 *   把「判别式的求根公式」拆成 判/别/别式/式的/… 这些两字组合，
 *   再看目标段落里出现过多少。不需要任何词典或分词器，
 *   中文英文都能用，而且完全离线。
 *
 * 这是「够用就好」的取舍：它不是语义检索（问「怎么解方程」找不到只讲「求根公式」的段落），
 * 但零依赖、零成本、结果可解释。真要语义，M7 之后再接 embedding。
 */

export interface ChunkDraft {
  /** 在原文里的字符偏移（用于将来定位到原书位置） */
  start: number;
  end: number;
  text: string;
  /** 这一块所属的最近一个标题（Markdown 的 # 或纯文本里独立成行的小标题） */
  heading: string | null;
}

export interface ChunkOptions {
  /** 每块的目标字数（中文按字符算）。默认 700 */
  targetChars?: number;
  /** 上限。超过就在段落边界处切开；单个段落本身就超长时只能硬切 */
  maxChars?: number;
}

const DEFAULT_TARGET = 700;
const DEFAULT_MAX = 1200;

/** 一行是不是标题：Markdown 的 #，或者很短、没有句末标点的一行 */
function headingOf(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  const md = /^#{1,6}\s+(.+)$/.exec(trimmed);
  if (md !== null) return md[1]?.trim() ?? null;

  // 短行 + 没有句末标点 → 当成小标题（中文书里很常见）
  if (trimmed.length <= 24 && !/[。！？.!?；;：:]$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * 把一篇长文切成块。
 *
 * 规则：
 *   ① 先按空行切成段落（同时记住每个段落前面的最近一个标题）
 *   ② 一段一段往当前块里加，加到超过目标字数就收一块
 *   ③ **尽量不切断段落** —— 断在半句话上对检索是灾难
 *   ④ 只有单个段落本身就超过上限时，才按句号硬切
 */
export function chunkText(text: string, options: ChunkOptions = {}): ChunkDraft[] {
  const target = options.targetChars ?? DEFAULT_TARGET;
  const max = Math.max(target, options.maxChars ?? DEFAULT_MAX);

  const chunks: ChunkDraft[] = [];
  let current = '';
  let currentStart = 0;
  let currentHeading: string | null = null;
  let cursor = 0;

  const flush = (endAt: number): void => {
    const body = current.trim();
    if (body !== '') {
      chunks.push({ start: currentStart, end: endAt, text: body, heading: currentHeading });
    }
    current = '';
  };

  // 按行处理，保留每行的原始偏移
  const lines = text.split('\n');
  const paragraph: string[] = [];
  let paragraphStart = 0;
  let offset = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const body = paragraph.join('\n').trim();
    paragraph.length = 0;
    if (body === '') return;

    const startAt = paragraphStart;

    // 单个段落就超长 → 先收掉手上的，再按句号硬切
    if (body.length > max) {
      flush(cursor);
      for (const piece of splitLongParagraph(body, max)) {
        chunks.push({ start: startAt, end: startAt + body.length, text: piece, heading: currentHeading });
      }
      return;
    }

    if (current === '') {
      currentStart = startAt;
    } else if (current.length + body.length + 2 > target) {
      flush(cursor);
      currentStart = startAt;
    }

    current = current === '' ? body : `${current}\n\n${body}`;
    cursor = offset;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineStart = offset;
    offset += line.length + 1; // +1 是那行末尾的换行

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    const heading = headingOf(line);
    if (heading !== null) {
      // 标题单独成段，并且成为后续段落的归属
      flushParagraph();
      flush(lineStart);
      currentHeading = heading;
      paragraph.push(line);
      paragraphStart = lineStart;
      continue;
    }

    if (paragraph.length === 0) paragraphStart = lineStart;
    paragraph.push(line);
  }

  flushParagraph();
  flush(cursor);

  // 去掉连续的重复块（标题行有时候会连着被切两次）
  return chunks.filter((c, i) => i === 0 || c.text !== chunks[i - 1]?.text);
}

/** 超长段落：优先在句末标点处切，实在没有就硬切 */
function splitLongParagraph(body: string, max: number): string[] {
  const pieces: string[] = [];
  const sentences = body.split(/(?<=[。！？.!?])\s*/);

  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > max) {
      if (current !== '') {
        pieces.push(current);
        current = '';
      }
      for (let i = 0; i < sentence.length; i += max) pieces.push(sentence.slice(i, i + max));
      continue;
    }
    if (current.length + sentence.length > max) {
      pieces.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim() !== '') pieces.push(current);
  return pieces.map((p) => p.trim()).filter((p) => p !== '');
}

// ── 检索 ──────────────────────────────────────────────────────

/** 取字符二元组。空白全部去掉，避免换行影响 */
export function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 2 <= normalized.length; i += 1) {
    out.add(normalized.slice(i, i + 2));
  }
  return out;
}

/** 低于这个分数就不返回 —— 宁可不给，也别拿一堆无关段落去污染上下文 */
export const MIN_SCORE = 0.12;

/**
 * 给一段正文打一个「和这个问题有多相关」的分。
 *
 * 0 = 完全无关；大于 1 说明命中率很高。
 */
export function scoreText(query: string, text: string): number {
  const q = query.trim().toLowerCase().replace(/\s+/g, '');
  if (q === '') return 0;

  const t = text.toLowerCase();

  let score = 0;

  // 整句原样命中：用户直接把书里的话贴进来了，那就是最相关的
  if (t.replace(/\s+/g, '').includes(q)) score += 1.5;

  const qGrams = bigrams(q);
  if (qGrams.size === 0) {
    // 查询太短（一个字符）—— 退回子串匹配
    return score > 0 ? score : 0;
  }

  const tGrams = bigrams(t);
  let hit = 0;
  for (const gram of qGrams) {
    if (tGrams.has(gram)) hit += 1;
  }
  score += hit / qGrams.size;

  return score;
}

export interface MaterialCandidate {
  chunkId: string;
  docId: string;
  docTitle: string;
  heading: string | null;
  text: string;
}

export interface MaterialHit extends MaterialCandidate {
  score: number;
}

/**
 * 从全部资料块里找出和问题最相关的几块。
 *
 * @param limit 最多给模型几块 —— **别贪多**：塞太多会让上下文变贵、还会稀释重点
 */
export function searchMaterials(
  candidates: readonly MaterialCandidate[],
  query: string,
  limit = 4,
): MaterialHit[] {
  const hits: MaterialHit[] = [];
  for (const candidate of candidates) {
    const score = scoreText(query, candidate.text);
    if (score >= MIN_SCORE) hits.push({ ...candidate, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
