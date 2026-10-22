// 联网检索模块（子站问答的「第二段」数据源）
//
// 设计依据：`知识库联网查询方案.md`
//   §5.5  参数配方（2026-10-19 实测，5 个真实 9699 问题）
//   §11.4 来源分级（quality / region / primary，纯规则表）
//
// 两个源分工固定，**不能混用**：
//   Tavily   → 现实案例 / 数据，吃**自然语言长句**
//   OpenAlex → 过往研究，吃 **2–4 个关键词**（`title_and_abstract.search` 是 AND 全词匹配，长句召回归零）
//
// 三条实测得来的硬规则，改代码时别违反：
//   1. OpenAlex **绝不能** `sort=cited_by_count` —— 会把《13 ESH/ESC 高血压指南》这种
//      池子里最著名的无关文献顶到 top3（召回池 2.4 万–54 万篇）。
//   2. OpenAlex **不加硬性年份过滤** —— 池子大时无影响，池子小时（25→12）相关性反而变差。
//   3. 来源可信度由**规则表**判定，**不调模型**（第四节红线：不许让模型判断来源可信）。

import { aiGateForbidden, bearer, verifyUser, type AuthEnv } from './ai/auth';
import { completeText, type TextEnv } from './ai/text';

export interface WebSearchEnv extends AuthEnv, TextEnv {
  TAVILY_API_KEY?: string;
  OPENALEX_API_KEY?: string;
  /** 仅本地/预览设置：允许用 X-Lab-Token 绕过登录做自测（生产不设 ⇒ 该分支不存在） */
  LAB_TOKEN?: string;
}

export type SourceQuality = 'official' | 'academic' | 'media' | 'advocacy' | 'commercial' | 'blog';
export type SourceRegion = 'UK' | 'US' | 'IN' | 'SE' | 'EU' | 'global' | 'unknown';

export interface WebSource {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  /** 来源性质（规则表判定） */
  quality: SourceQuality;
  /** 国别（9699 是国际考试，任何国家数据都可用；标注只为防"误标国别"） */
  region: SourceRegion;
  /** 是否原始出处（官方统计 / 期刊论文本身 = true；转述 = false） */
  primary: boolean;
  source: 'tavily' | 'openalex';
  year?: number;
  venue?: string;
  citedBy?: number;
  /** 作者姓氏（最多 4 个）。引用需要作者，光有刊名不够；Tavily 侧通常没有 */
  authors?: string[];
}

export interface WebSearchMeta {
  tavily: { ok: boolean; ms: number; count: number; error?: string };
  openalex: { ok: boolean; ms: number; count: number; error?: string };
  /** 被黑名单挡掉的条数（论文代写站等） */
  blocked: number;
  total: number;
}

export interface WebSearchResult {
  sources: WebSource[];
  meta: WebSearchMeta;
}

// ---------------------------------------------------------------------------
// §11.4 规则表（种子值，按需增补）
// ---------------------------------------------------------------------------

/**
 * 黑名单：
 *  - 代写/题库站（实测 `ukessays.com` 真的会出现在结果里，§5.5⑤）
 *  - 八卦/小报（2026-10-22 教师实测：中文提问时检索结果混进明星八卦 —— 对 9699 全是噪音）
 */
const BLOCKLIST = [
  'ukessays.com', 'essaypro', 'studocu', 'coursehero', 'gradesfixer',
  'bartleby', 'ipl.org', '123helpme', 'papersowl', 'academized', 'boompapers',
  'dailymail.co.uk', 'thesun.co.uk', 'mirror.co.uk', 'ok.co.uk',
  'hellomagazine.com', 'closeronline.co.uk', 'thelist.com', 'nickiswift.com',
  // 社交平台上的碎片帖：实测出现过 m.facebook.com 的离婚服务广告（2026-10-22）
  'facebook.com', 'm.facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'tiktok.com', 'quora.com', 'pinterest.com', 'reddit.com', 'linkedin.com',
];

/** 官方：政府 / 议会 / 统计机构 / 国际组织 */
const OFFICIAL_HOSTS = [
  'ons.gov.uk', 'gov.uk', 'parliament.uk', 'eurostat', 'ec.europa.eu',
  'who.int', 'un.org', 'oecd.org', 'worldbank.org', 'census.gov', 'data.gov',
];

/** 学术：出版方与文献库（另配 `.ac.uk` / `.edu` 等后缀规则） */
const ACADEMIC_HOSTS = [
  'ncbi.nlm.nih.gov', 'pmc.ncbi.nlm.nih.gov', 'jstor.org', 'sciencedirect.com',
  'link.springer.com', 'springer.com', 'tandfonline.com', 'journals.sagepub.com',
  'sagepub.com', 'academic.oup.com', 'cambridge.org', 'jmir.org', 'frontiersin.org',
  'nature.com', 'plos.org', 'journals.plos.org', 'researchgate.net', 'ssrn.com',
  'semanticscholar.org', 'openalex.org', 'doi.org',
  // 出版方域名：实测 onlinelibrary.wiley.com 曾掉进 blog 档（2026-10-22）
  'wiley.com', 'onlinelibrary.wiley.com', 'emerald.com', 'tandf.co.uk',
  // 实测把期刊/大学出版社误判成 blog 的（同日）
  'bristoluniversitypressdigital.com', 'bristoluniversitypress.co.uk',
  'demographic-research.org', 'ingentaconnect.com', 'annualreviews.org',
];
const ACADEMIC_SUFFIX = ['.ac.uk', '.edu', '.edu.au', '.ac.nz'];

/** 媒体：主流新闻与解释性媒体 */
const MEDIA_HOSTS = [
  'bbc.co.uk', 'bbc.com', 'theguardian.com', 'theconversation.com', 'reuters.com',
  'ft.com', 'economist.com', 'telegraph.co.uk', 'independent.co.uk',
  'nytimes.com', 'washingtonpost.com', 'aljazeera.com',
];

/** 倡导组织：有立场（实测 `c4m.org.uk` 转述的 ONS 数字看起来最权威，必须标出来） */
const ADVOCACY_HOSTS = [
  'c4m.org.uk', 'ifstudies.org', 'marriagefoundation.org.uk',
  'cpag.org.uk', 'jrf.org.uk', 'equalityhumanrights.com',
];

/** 商业：律所 / 教育公司 / 数据商 / 婚恋与招聘平台 */
const COMMERCIAL_HOSTS = [
  'russell-cooke.co.uk', 'tutor2u.net', 'structural-learning.com',
  'connectedcouples.app', 'statista.com', 'linkedin.com', 'indeed.com', 'glassdoor.com',
];

const QUALITY_RANK: Record<SourceQuality, number> = {
  official: 0, academic: 1, media: 2, advocacy: 3, commercial: 4, blog: 5,
};

/** 国别：后缀优先，其次看标题/摘要里的国名（判不出就是 unknown，**不许猜**） */
const REGION_SUFFIX: [string, SourceRegion][] = [
  ['.gov.uk', 'UK'], ['.ac.uk', 'UK'], ['.co.uk', 'UK'], ['.uk', 'UK'],
  ['.gov', 'US'], ['.edu', 'US'], ['.edu.au', 'global'],
  ['.in', 'IN'], ['.se', 'SE'], ['.eu', 'EU'],
];
/** 长后缀优先：`.edu.au` 必须先于 `.edu` 命中 */
const REGION_SUFFIX_LONGEST_FIRST = [...REGION_SUFFIX].sort((a, b) => b[0].length - a[0].length);
const REGION_WORDS: [RegExp, SourceRegion][] = [
  [/\b(united kingdom|britain|british|england|wales|scotland|northern ireland|ONS)\b/i, 'UK'],
  [/\b(united states|u\.s\.a?\.?|americans?)\b/i, 'US'],
  [/\b(india|indian)\b/i, 'IN'],
  [/\b(sweden|swedish)\b/i, 'SE'],
];

const has = (host: string, list: string[]) => list.some((x) => host === x || host.endsWith(`.${x}`));

/** 非内容页标题（实测 committees.parliament.uk 返回过 "Our use of cookies"） */
const JUNK_TITLE = /^(our use of cookies|cookies?\b|privacy (policy|notice)|terms of (use|service)|sign in|log ?in|register|access denied|page not found|404\b)/i;

/**
 * 停用词：把"学生的问题"降级成关键词时的必需过滤。
 * 踩过的坑：英文原句取前 4 个词得到 `marriage is no longer`，
 * 拿去做 OpenAlex 的 AND 匹配 ⇒ 0 篇（2026-10-22）。
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'such',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'has', 'have', 'had', 'will', 'would', 'should', 'can', 'could', 'may', 'might', 'must',
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'by', 'as', 'into', 'over',
  'under', 'between', 'among', 'about', 'against', 'through', 'during', 'above', 'below',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'their', 'them', 'they',
  'he', 'she', 'we', 'you', 'i', 'my', 'your', 'our', 'his', 'her',
  'not', 'no', 'nor', 'only', 'also', 'very', 'more', 'most', 'less', 'least',
  'what', 'which', 'who', 'whom', 'whose', 'how', 'why', 'where', 'when', 'while',
  'many', 'much', 'some', 'any', 'all', 'both', 'each', 'other', 'same',
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function gradeQuality(host: string): SourceQuality {
  if (has(host, OFFICIAL_HOSTS)) return 'official';
  if (has(host, ACADEMIC_HOSTS) || ACADEMIC_SUFFIX.some((s) => host.endsWith(s))) return 'academic';
  if (has(host, MEDIA_HOSTS)) return 'media';
  if (has(host, ADVOCACY_HOSTS)) return 'advocacy';
  if (has(host, COMMERCIAL_HOSTS)) return 'commercial';
  return 'blog';
}

function gradeRegion(host: string, text: string, quality: SourceQuality): SourceRegion {
  // 学术来源**只看文本**：`pmc.ncbi.nlm.nih.gov` 是美国的文献库，但论文研究的是哪国
  // 跟托管地无关 —— 按 TLD 判会得出"美国研究"这种错标（2026-10-22 实测踩到）。
  if (quality === 'academic') {
    for (const [re, region] of REGION_WORDS) if (re.test(text)) return region;
    return 'unknown';
  }
  for (const [suffix, region] of REGION_SUFFIX_LONGEST_FIRST) {
    if (host.endsWith(suffix)) return region;
  }
  for (const [re, region] of REGION_WORDS) if (re.test(text)) return region;
  return 'unknown';
}

/** 原始出处：官方统计与期刊论文本身算原始；媒体/倡导/商业/博客多为转述 */
function isPrimary(quality: SourceQuality): boolean {
  return quality === 'official' || quality === 'academic';
}

function isBlocked(host: string): boolean {
  return BLOCKLIST.some((b) => host === b || host.endsWith(`.${b}`));
}

/**
 * 取作者姓氏（引用只需姓氏：Sanders, 1991）。
 * OpenAlex 的 `author.display_name` 是"名 姓"或"姓 名"混排，取最后一个词作姓氏在
 * 绝大多数英文名上成立；取不到就返回空数组，界面不显示作者行（不要瞎猜）。
 */
function surnamesOf(authorships: unknown): string[] {
  if (!Array.isArray(authorships)) return [];
  const out: string[] = [];
  for (const a of authorships) {
    const name = ((a as { author?: { display_name?: string } })?.author?.display_name ?? '').trim();
    if (!name) continue;
    const parts = name.split(/\s+/);
    const surname = parts[parts.length - 1].replace(/[^\p{L}'-]/gu, '');
    if (surname) out.push(surname);
    if (out.length >= 4) break;
  }
  return out;
}

/** OpenAlex 摘要以 inverted index 存储，这里还原成可读片段（失败返回空串，不影响主流程） */
function abstractOf(inverted: unknown): string {
  if (!inverted || typeof inverted !== 'object') return '';
  const pairs: [number, string][] = [];
  for (const [word, positions] of Object.entries(inverted as Record<string, number[]>)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (typeof p === 'number') pairs.push([p, word]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map((p) => p[1]).join(' ').slice(0, 360);
}

// ---------------------------------------------------------------------------
// 查询词改写（中文提问必需）
//
// 2026-10-22 教师实测：中文提问 → 结果混进明星八卦、几乎没有学术材料。
// 根因不是"没翻译"，而是**把「术语表」当「检索句」用**：
//   旧做法 = 小模型吐 8–12 个关键词 → 空格拼成一句丢给 Tavily
//          → 等于告诉搜索引擎"这些词随便哪个出现都算" → 八卦页最省事、最容易命中
// 正确做法 = 一次改写，产出**两种**输入：
//   query    → 自然语言检索句（给 Tavily）
//   keywords → 2–4 个实词（给 OpenAlex 的 AND 匹配）
// ---------------------------------------------------------------------------

const REWRITE_SYSTEM = [
  "You rewrite a student's A-level sociology question into search-engine inputs.",
  'Return STRICT JSON only, no markdown, no explanation: {"query":"...","keywords":["...","..."]}',
  '- query: ONE natural-language English search sentence, 8-20 words. Preserve the question\'s intent.',
  '  Write what a researcher would actually type, not a word-for-word translation.',
  '  Target REAL-WORLD evidence: news, official statistics (e.g. ONS), surveys, policy reports, documented events.',
  '  It may read like a search-box entry rather than a grammatical sentence; be specific, not generic.',
  '  Include at least one evidence anchor (statistics / survey / trend / report / policy) or "sociology",',
  '  but do NOT use study/journal/paper/research words — the academic side is searched separately with keywords.',
  '  Never put "gossip", "celebrity" or entertainment framing in it.',
  '- keywords: 2-3 English content words for an academic database (they are AND-matched: ALL must appear).',
  '  Prefer broader concepts that plausibly co-occur; NEVER stack four narrow concepts (that returns zero hits).',
  '  No stopwords; omit theorist names unless the question is about that theorist.',
  '- Use standard English sociological terminology for Chinese terms, e.g.',
  '  婚姻/家庭破裂 → marriage / family breakdown / lone parenthood;',
  '  性别分工 → division of domestic labour; 教育成就 → educational attainment;',
  '  社会流动 → social mobility; 标签理论 → labelling theory.',
  '- If the question is already English, do NOT return it verbatim: compress it into a search query',
  '  that keeps the key noun phrase and adds an evidence anchor',
  '  (e.g. "marriage is no longer important" → "decline of marriage statistics cohabitation UK").',
  '- No Chinese characters anywhere in the output.',
].join('\n');

export interface Rewrite { query: string; keywords: string[] }

/** 一次改写 → 两个源各自的输入。失败返回 null（调用方降级，不要硬用中文去搜） */
export async function rewriteSearchQuery(
  question: string, env: WebSearchEnv,
): Promise<Rewrite | null> {
  try {
    const r = await completeText(`问题：${question}`, 'auto', env, {
      system: REWRITE_SYSTEM,
      maxTokens: 220,
      temperature: 0.1,
      timeoutMs: 20_000,
    });
    if (!r.ok) return null;
    const text = r.text.trim();
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    const j = JSON.parse(text.slice(s, e + 1)) as { query?: unknown; keywords?: unknown };
    const query = typeof j.query === 'string' ? j.query.trim() : '';
    const keywords = Array.isArray(j.keywords)
      ? j.keywords
          .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
          .map((x) => x.trim())
          .slice(0, 4)
      : [];
    // 中文残留 = 改写没成功，宁可降级也不要发给英文检索源
    if (!query || /[\u4e00-\u9fff]/.test(query)) return null;
    return { query, keywords };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 两个源的取数（并行；任一失败不影响另一个）
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 9000;

async function fromTavily(
  key: string, query: string, limit: number,
): Promise<WebSource[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query, search_depth: 'basic', max_results: limit,
      // 让源端就不要返回代写站/八卦站，省得靠事后过滤浪费名额
      exclude_domains: BLOCKLIST,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (body.results ?? []).map((r) => {
    const url = r.url ?? '';
    const host = hostOf(url);
    const title = (r.title ?? '').trim();
    const snippet = (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 360);
    const quality = gradeQuality(host);
    return {
      title, url, domain: host, snippet, quality,
      region: gradeRegion(host, `${title} ${snippet}`, quality),
      primary: isPrimary(quality),
      source: 'tavily' as const,
    };
  });
}

async function fromOpenAlex(
  key: string, short: string, limit: number,
): Promise<WebSource[]> {
  // ⚠ 口径固定见本文件顶部：title_and_abstract.search + 仅 article + **不排序、不加年份**
  const url = 'https://api.openalex.org/works?filter=title_and_abstract.search:'
    + encodeURIComponent(short)
    + ',type:article'
    + `&per_page=${limit}`
    + '&select=id,doi,display_name,publication_year,cited_by_count,primary_location,abstract_inverted_index,authorships'
    + (key ? `&api_key=${encodeURIComponent(key)}` : '');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'sociologyvocab/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`openalex ${res.status}`);
  const body = (await res.json()) as {
    results?: {
      id?: string; doi?: string | null; display_name?: string; publication_year?: number;
      cited_by_count?: number; primary_location?: { source?: { display_name?: string } };
      abstract_inverted_index?: unknown;
      authorships?: unknown;
    }[];
  };
  return (body.results ?? []).map((w) => {
    const link = w.doi || w.id || '';
    const host = hostOf(link) || 'openalex.org';
    const title = (w.display_name ?? '').trim();
    const venue = w.primary_location?.source?.display_name ?? '';
    const snippet = abstractOf(w.abstract_inverted_index);
    const quality: SourceQuality = 'academic';
    return {
      title, url: link, domain: host, snippet, quality,
      // 论文自身几乎不标国别 ⇒ 从标题/摘要里判断，判不出就是 unknown
      region: gradeRegion(host, `${title} ${snippet}`, quality),
      primary: true,
      source: 'openalex' as const,
      year: w.publication_year,
      venue,
      citedBy: w.cited_by_count,
      authors: surnamesOf(w.authorships),
    };
  });
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

type Attempt<T> =
  | { ok: true; items: T; ms: number }
  | { ok: false; error: string; ms: number };

/** 单源计时包装：失败不抛异常，只记账（任一源挂了另一源照常返回） */
async function timed<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  const t0 = Date.now();
  try {
    return { ok: true, items: await fn(), ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 120), ms: Date.now() - t0 };
  }
}

export interface SearchOptions {
  /** 给 Tavily 的自然语言长句 */
  query: string;
  /** 给 OpenAlex 的 2–4 个关键词；不传则退回用 query 的前 4 个实词 */
  short?: string;
  limit?: number;
}

/**
 * 两源并行检索 + 归一 + 分级 + 排序。
 * 任一源失败仍返回另一源的结果（`meta` 里标明），不抛异常。
 */
export async function searchWeb(env: WebSearchEnv, opts: SearchOptions): Promise<WebSearchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 8);
  // 关键词必须过滤停用词，否则 AND 匹配直接归零
  const short = opts.short?.trim() || contentWords(opts.query).slice(0, 3).join(' ');

  const meta: WebSearchMeta = {
    tavily: { ok: false, ms: 0, count: 0 },
    openalex: { ok: false, ms: 0, count: 0 },
    blocked: 0,
    total: 0,
  };

  // 中文绝不打给 Tavily：中文检索质量极差（§5.5⑥）。改写失败时宁可只走 OpenAlex。
  const tavilyQuery = /[\u4e00-\u9fff]/.test(opts.query) ? '' : opts.query;

  let [tav, oa] = await Promise.all([
    // 多要一倍：去重与黑名单会吃掉名额，多取一些才有得补（Tavily 按次计费，与条数无关）
    timed(() => (env.TAVILY_API_KEY && tavilyQuery
      ? fromTavily(env.TAVILY_API_KEY, tavilyQuery, Math.min(limit * 2, 10))
      : Promise.reject(new Error('no english query')))),
    timed(() => (env.OPENALEX_API_KEY && short
      ? fromOpenAlex(env.OPENALEX_API_KEY, short, limit)
      : Promise.reject(new Error('no keywords')))),
  ]);

  // 关键词越多，AND 匹配越容易归零（实测 4 个词 → 0 篇）。
  // 归零时逐步丢掉最窄的词重试：3 → 2 → 1。宁可少两个词，也不要空手而归。
  if (oa.ok && oa.items.length === 0 && env.OPENALEX_API_KEY) {
    const kw = short.split(/\s+/).filter(Boolean);
    for (let n = kw.length - 1; n >= 1; n--) {
      const retry = await timed(() => fromOpenAlex(env.OPENALEX_API_KEY!, kw.slice(0, n).join(' '), limit));
      if (retry.ok && retry.items.length) { oa = retry; break; }
    }
  }

  const collected: WebSource[] = [];
  meta.tavily.ms = tav.ms;
  if (tav.ok) {
    meta.tavily.ok = true;
    meta.tavily.count = tav.items.length;
    collected.push(...tav.items);
  } else {
    meta.tavily.error = tav.error;
  }
  meta.openalex.ms = oa.ms;
  if (oa.ok) {
    meta.openalex.ok = true;
    meta.openalex.count = oa.items.length;
    collected.push(...oa.items);
  } else {
    meta.openalex.error = oa.error;
  }

  // 去重：Tavily 会把同一个 URL 重复返回（实测一次给了 4 条相同的 revisesociology 页），
  // 不去重会让来源列表和交给模型的材料一起被灌水。
  const seen = new Set<string>();
  const filtered = collected.filter((s) => {
    if (!s.title || !s.url) return false;
    if (JUNK_TITLE.test(s.title.trim())) { meta.blocked++; return false; }
    if (isBlocked(s.domain)) { meta.blocked++; return false; }
    const key = s.url.split('#')[0].replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 排序：**先按两半分组**（案例侧在前、研究侧在后），组内再按来源性质，
  // 同档保留检索原序（不按被引 —— 见文件头规则 1）。
  // 分组而不是全局按质量排：否则学术论文会把"现实案例"整体挤到最后（2026-10-22 教师反馈）。
  filtered.sort((a, b) => {
    const group = (a.source === 'tavily' ? 0 : 1) - (b.source === 'tavily' ? 0 : 1);
    return group !== 0 ? group : QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality];
  });

  // 排完再按源截断到 limit：这样被去重/黑名单吃掉的名额由后面的低一档结果补上，
  // 而不是让某一源整体少几条。
  const per: Record<string, number> = { tavily: 0, openalex: 0 };
  const capped = filtered.filter((s) => {
    if ((per[s.source] ?? 0) >= limit) return false;
    per[s.source] = (per[s.source] ?? 0) + 1;
    return true;
  });
  meta.total = capped.length;

  return { sources: capped, meta };
}

// ---------------------------------------------------------------------------
// 路由：POST /skill-api/web-search
// 鉴权与门禁与 /skill-api/ask 完全一致（登录 + ai_gate）
// ---------------------------------------------------------------------------

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export async function handleWebSearch(request: Request, env: WebSearchEnv): Promise<Response> {
  let body: {
    query?: string;
    /** 术语桥产出的英文检索词（中文提问必备：中文直投 Tavily 召回质量很差，§5.5⑥） */
    terms?: string[];
    short?: string;
    limit?: number;
    simulateStudent?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'bad json' });
  }

  // 自测通道：**仅当配置了 LAB_TOKEN** 才可能命中（生产不设该 secret ⇒ 整条分支等于不存在）。
  // 用途：本机 / 预览没有学生登录态时，用 X-Lab-Token 直接验检索质量与来源分级。
  const labToken = env.LAB_TOKEN ?? '';
  const labOk = labToken !== '' && request.headers.get('X-Lab-Token') === labToken;

  if (!labOk) {
    const token = bearer(request);
    if (!token) return json(401, { error: 'unauthorized' });
    const userId = await verifyUser(token, env);
    if (!userId) return json(401, { error: 'invalid session' });
    const gateNote = await aiGateForbidden(userId, token, env, body.simulateStudent === true);
    if (gateNote) return json(403, { error: 'ai_paused', detail: gateNote });
  }

  const question = (body.query ?? '').trim().slice(0, 300);
  const terms = Array.isArray(body.terms)
    ? body.terms
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        .map((t) => t.trim().slice(0, 40))
        .slice(0, 8)
    : [];
  if (!question && !terms.length) return json(400, { error: 'missing query' });
  if (!env.TAVILY_API_KEY && !env.OPENALEX_API_KEY) {
    return json(503, { error: 'no_search_key' });
  }

  // 两个源吃两套词（§5.5①）。中文提问必须先改写：一次调用同时产出
  //   query    → 自然语言检索句（Tavily）
  //   keywords → 2–4 个实词（OpenAlex 的 AND 匹配）
  const isZh = /[\u4e00-\u9fff]/.test(question);
  let enQuery = '';
  let short = (body.short ?? '').trim().slice(0, 120);
  let rewritten = false;

  // **中英文都要改写**：学生写的是「问题」，不是「检索式」。
  // 英文原句直投 Tavily 同样会退化（实测："marriage is no longer important" → 只回 1 条
  // 关岛离婚服务的 Facebook 页），并且把前四个词当关键词会因停用词让 OpenAlex 归零。
  const rw = await rewriteSearchQuery(question, env);
  if (rw) {
    enQuery = rw.query;
    if (!short) short = rw.keywords.join(' ');
    rewritten = true;
  }
  if (!enQuery) {
    // 改写失败：英文还能用原句兜一下；中文绝不直投英文检索源
    enQuery = isZh ? terms.join(' ') : question;
  }
  if (!short) short = contentWords(terms.join(' ') || question).slice(0, 3).join(' ');
  // 改写出不来、也没有任何可用英文词：宁可明确失败，也不要拿中文去打英文源
  if (!enQuery && !short) return json(422, { error: 'rewrite_failed' });

  try {
    const result = await searchWeb(env, {
      query: enQuery,
      short,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
    });
    // usedQuery/usedShort 回传实际检索串，便于前端/教师解释"为什么出来这些"
    return json(200, { ...result, usedQuery: enQuery, usedShort: short, rewritten });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[skill-api/web-search] error:', msg);
    return json(502, { error: 'search failed', detail: msg.slice(0, 200) });
  }
}
