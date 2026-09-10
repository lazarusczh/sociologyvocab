// 教材知识站问答的检索 + prompt 组装
// 内容已整份在浏览器（登录后拉取），直接在本地做关键词/术语召回，无需服务端向量库
import { booksOf, type Book, type GlossaryEntry, type Section } from './data'
import type { SkillData } from './data'

// 材料预算（2026-09-09 放宽：上游按调用次数而非 token 计费，喂更多材料不增加成本，
// 可弥补 skill 蒸馏可能丢的细节；上限仍保留以防窗口溢出与无关段落稀释）。
const MAX_PARTS = 12;            // 作为材料喂给模型的段落块上限
const PART_CHAR_LIMIT = 1000;   // 每段截断
const TOTAL_CHAR_BUDGET = 10000; // 材料总量上限（含术语块）

// 「评分视角本」处理：命中即按整章合并成一份「论据档案」喂入（而非按小节零散截取），
// 保住该考点的 措辞→证据链→平衡收尾 完整性；档案文本仅供模型消化为论据，
// 评分元信息（小节名里的「评分/失分」等）与真题编号是否外露由 system 统一约束。
const EXAM_ARCHIVE_CHAR = 1500;
const isExamBook = (b: Book) => b.kind === '真题' || b.slug === 'papers';
// 评分章标题形如「家庭与父权（…）：26 分评估题评分视角」，出处/块标签只保留冒号前的主标题
const examShortTitle = (t: string) => t.split(/[：:]/)[0].trim();

interface Hit {
  book: string;      // 书目名（用于出处标注）
  chapter: string;   // 章节名
  source: string;    // 完整出处：书目 › 章节 › 小节
  text: string;
  score: number;
}

// 英文停用词：检索时忽略，避免 is/the/of 这类词让每个段落都拿到基础分、
// 把真正命中的段落稀释掉（此前 "family is patriarchal" 里的 is 会把排序搅乱）
const STOP_EN = new Set(
  ('a an the and or but of to in for on with by at from as is are was were be been being it its this that these those they them their ' +
    'he she his her we our you your i not no do does did have has had what which who whom whose when where why how can could would should may might must shall will ' +
    'into than so then also more most such only just because if about against between through during after before above below up down out over under again here there too').split(' '),
);

// 独立「宗教主题」章的识别与放行信号：宗教是选修（本课不教），默认不让 AI 问答
// 去抓宗教独立章，避免 family 等无关问题被它带偏；但问题里明显指向宗教领域时才放行。
// 嵌在 socialisation/family 等章内部的宗教论述不在此列（那些章不是独立宗教章，不设门）。
const isReligionTopic = (ch: { id: string; title: string }) =>
  /religion|religious|宗教/.test(`${ch.id} ${ch.title}`);
const REL_SIGNAL =
  /religion|religious|church|churches|secular|secularis|belief|believing|god|faith|spiritual|cult|sects?|ritual|worship|宗教|信仰|世俗|教会|教派|仪式|神灵|神学|礼拜/i;

// 从问题提取检索词：英文整词（去停用词）+ 中文双字组（去停用词）
function tokenize(q: string): string[] {
  const tokens = new Set<string>();
  const en = q.match(/[a-zA-Z][a-zA-Z\-']{1,}/g) ?? [];
  for (const w of en) if (w.length > 1 && !STOP_EN.has(w.toLowerCase())) tokens.add(w.toLowerCase());
  const zh = q.replace(/[a-zA-Z0-9\s·•,，。.！？?、；;：:""''（）()《》<>/-]/g, '');
  for (let i = 0; i + 1 < zh.length; i++) {
    const bigram = zh.slice(i, i + 2);
    if (!['什么', '怎么', '如何', '为什', '是否', '哪些', '老师', '请问', '解释', '简述', '分析'].includes(bigram)) {
      tokens.add(bigram);
    }
  }
  return [...tokens].slice(0, 24);
}

// 术语优先精确命中；然后对章节段落打分
export function retrieve(skill: SkillData, question: string): { system: string; context: string; sources: string[] } {
  const q = question.trim();
  const terms = tokenize(q);
  const books = booksOf(skill);   // AI 集大成：跨全部书目检索
  const sources = new Set<string>();

  // 1) 术语表命中：跨本「同名术语各本释义都保留」，让模型能对比两本措辞差异；
  //    去重只限同一本书内部（避免同书条目把同一术语写两遍）
  const topTerms: { g: GlossaryEntry; book: string; label: string }[] = [];
  for (const b of books) {
    const seenInBook = new Set<string>();
    for (const g of b.glossary) {
      const hit =
        terms.some((t) => g.term.toLowerCase().includes(t)) || (g.zh.length >= 2 && q.includes(g.zh));
      if (!hit) continue;
      const key = g.term.toLowerCase();
      if (seenInBook.has(key)) continue;
      seenInBook.add(key);
      topTerms.push({ g, book: b.slug, label: b.label });
    }
  }

  // 2) 章节打分：教材按小节命中；评分视角本按「整章论据档案」命中。
  //    先本内排序，再「每本保底一段 + 全局按分补齐」——否则篇幅大的教辅会把教材内容挤光。
  const secScore = (ch: { id: string; sections: Section[] }, blob: string): number => {
    const lower = blob.toLowerCase();
    let s = 0;
    for (const t of terms) {
      let idx = lower.indexOf(t);
      let n = 0;
      while (idx !== -1 && n < 20) { n++; idx = lower.indexOf(t, idx + t.length); }
      if (n > 0) s += 1 + Math.min(n, 5);
    }
    // 术语章节回指加权：g.chapters 形如 ch01，需与章节 id 做包含判断
    for (const { g } of topTerms) {
      if (g.chapters.some((c) => ch.id.includes(c))) s += 3;
    }
    return s;
  };
  const perBook: Hit[][] = books.map((b) => {
    const hits: Hit[] = [];
    const exam = isExamBook(b);
    for (const ch of b.chapters) {
      // 独立宗教主题章默认跳过检索（选修不教）；问题明确指向宗教领域时才放行
      if (isReligionTopic(ch) && !REL_SIGNAL.test(q)) continue;
      if (exam) {
        // 评分本：任一节命中就把整章相关节合并成一份论据档案，保留考点完整性
        let score = 0;
        const parts: string[] = [];
        for (const sec of ch.sections) {
          const blob = `${sec.heading}\n${sec.lines.join('\n')}`;
          const s = secScore(ch, blob);
          if (s > 0) { score += s; parts.push(blob); }
        }
        if (parts.length) {
          const title = examShortTitle(ch.title);
          hits.push({
            book: b.label,
            chapter: title,
            source: `${b.label} › ${title}`,
            text: parts.join('\n\n').slice(0, EXAM_ARCHIVE_CHAR),
            score,
          });
        }
        continue;
      }
      for (const sec of ch.sections) {
        const blob = `${sec.heading}\n${sec.lines.join('\n')}`;
        const s = secScore(ch, blob);
        if (s > 0) {
          hits.push({
            book: b.label,
            chapter: ch.title,
            source: `${b.label} › ${ch.title} › ${sec.heading}`,
            text: blob.slice(0, PART_CHAR_LIMIT),
            score: s,
          });
        }
      }
    }
    hits.sort((a, b2) => b2.score - a.score);
    return hits;
  });

  // 关键：先把「每本各自最相关的一段」放进材料（跨本保底，保证每本都出现），
  // 再把其余段落全局按分补足。若像旧实现那样把保底与补足混在一起重排，
  // 高分同本段落会把另一本的片段挤出材料。
  const top: Hit[] = [];
  let used = 0;
  const pushTop = (p: Hit) => { top.push(p); used += p.text.length; };
  for (const hits of perBook) if (hits.length) pushTop(hits[0]); // 每本保底至少一段
  const rest = perBook.flatMap((h) => h.slice(1)).sort((a, b) => b.score - a.score);
  for (const p of rest) {
    if (top.length >= MAX_PARTS || used > TOTAL_CHAR_BUDGET) break;
    pushTop(p);
  }
  for (const p of top) sources.add(`${p.book} · ${p.chapter}`);

  // 3) 组装 context：术语按词聚合、各本释义并列；章节段跨本保底后按分补足
  const shortLabel = (label: string) => label.replace(/[（(].*?[）)]/g, '').trim();
  const cutDef = (d: string) => (d.length > 220 ? d.slice(0, 220) + '…' : d);
  const byTerm = new Map<string, { g: GlossaryEntry; label: string }[]>();
  for (const { g, label } of topTerms) {
    const k = g.term.toLowerCase();
    const arr = byTerm.get(k);
    if (arr) arr.push({ g, label });
    else byTerm.set(k, [{ g, label }]);
  }
  const blocks: string[] = [];
  // 章节段落放前面（主体材料），术语表放最后（仅作术语澄清），避免模型只按术语释义作答
  for (const p of top) blocks.push(`【${p.source}】\n${p.text}`);
  if (byTerm.size) {
    sources.add('术语表');
    const lines = [...byTerm.entries()]
      .slice(0, 6)
      .flatMap(([, arr]) =>
        arr.map(
          ({ g, label }) =>
            `- ${g.term}（${shortLabel(label)}）：${cutDef(g.def)}${g.chapters.length ? `〔${g.chapters.join(', ')}〕` : ''}`,
        ),
      );
    blocks.push(`【术语表命中（同名术语并列各书释义，供对比措辞）】\n${lines.join('\n')}`);
  }
  const context = blocks.join('\n\n---\n\n');

  // system：角色 + 教学口径（继承 SKILL.md 的答题人格）。
  // 注意：互补是「补充」不是模板——主线必须是完整作答，否则 8B 会被引导成压缩短答。
  // 真题本定位：只提供实战论据，绝不外露评分元讨论与真题编号（详见第 5 条）。
  const system = `你是 Cambridge 9699 A Level 社会学教师助手，依据已挂载的教材与按考点整理的语料作答。

作答要求：
1. 严格依据材料作答，不得编造理论家/年份/研究；材料未覆盖处明确说「知识库未覆盖」。正文行内书名仅在两本教材（《Haralambos》《Livesey & Blundell》）之间作区分时使用；出处不必逐句复述——材料块首行与页面底部已有完整来源。
2. 主体作答务必完整、有信息量：先给定义或核心结论，再展开机制与证据，需要时正反评价并给平衡结论（对应 AO1/AO2/AO3）。引用学者/研究时遵循「引用即论证」：把姓名嵌进它支撑的主张句——如主张家庭仍不平等的一方可引 Oakley 对性别角色社会化的批判、Dobash & Dobash 对婚内暴力的记录；主张已趋平等的一方则举 Willmott & Young 的 symmetrical family、Kaufman 的 involved father——让读者能看出「谁说了什么、站哪一边」。禁止把一串姓名/研究机械罗列成清单、只点名不给观点；材料仅点名未给观点的不要硬凑。禁止只给一句话术语释义、禁止把英文概念翻译成中文就算回答。概念/理论题主体展开到约 300–500 字（差异补充段另计）；若太短通常意味着漏了机制或证据，请按材料补全。
3. 涉及理论判断先归位「理论指纹」：功能主义(Durkheim/Parsons，value consensus/social solidarity)、马克思主义(Marx/Bowles&Gintis，correspondence principle/false consciousness)、女权主义(patriarchy/intersectionality)、互动论(Mead/Blumer/Goffman，labelling/impression management)、后现代(Lyotard/Baudrillard，simulacra/meta-narrative)。
4. 两本教材都覆盖同一问题时，主体完整展开后可用一小段点出两书侧重/出入（如某书更强调机制、另一书更强调批判），作为差异讨论；不要为了对比压缩主体；只有一本覆盖就按该书作答。
5. 材料中标为「真题 · 评分视角」的块是「实战论据集」：其中的观点、研究证据、正反立场与平衡收尾都按真实考题整理，与教材内容同等可信。用法只有一条——把它当作普通论据自然写进定义、证据链与评价里（它常比教材更"直接可用来答题"）。同时严格遵守：
   - 不得出现任何讨论考试评分机制的话（如"这类题常考/给分点/评分标准/答题策略/常见失分/AO3 拿分"等元叙述）；
   - 不得外露真题编号、卷别或任何代号（S21/S22/QP22 等一律不出现），也不要复述材料里的出处格式；
   - 不要向读者介绍"真题评分视角"这本资料，更不要把它与教材并列做来源对比。
6. 语言用简体中文为主，术语保留英文原词（如 meritocracy、secularisation）；中英术语可混查（如「文化资本」「cultural capital」均指 Bourdieu 概念）。
7. 中文译名一律使用社会学通行译法，禁止按字面直译，尤其不得出现：functionalism/functionalist=功能主义/功能主义者（严禁"函数主义"）；Marxism=马克思主义；feminism=女权主义（liberal/radical/Marxist feminism=自由派/激进派/马克思主义女权主义）；interactionism=互动论；postmodernism=后现代主义；value consensus=价值共识；social solidarity=社会团结；correspondence principle=对应原则；meritocracy 正文保留英文或写「按绩晋升」，勿自造生僻译名。同一术语全文译名保持一致。`;

  return { system, context, sources: [...sources].slice(0, 8) };
}

// ===== 教材原文页两级检索 =====
// 第一级：常驻前端的「页级索引」（每页的章/节标签 + 自动抽取的关键词）打分，得到候选页码；
// 第二级：只对命中的十几页按需拉取原文，保证研究案例这类正文细节不被蒸馏摘要丢掉。
export interface PageIndexBook {
  book: string;                                             // tb1 / tb2
  pages: { p: number; c: string | null; s: string | null; k: string[] }[];
  /** Unit 编号 → 起始页（Haralambos 有 Unit 体系；把蒸馏层的考点接回原书页码） */
  units?: Record<string, { title: string; page: number }>;
  /** 章名 → 起始页（无 Unit 体系的教材用它做范围标注） */
  chapters?: Record<string, { page: number }>;
}
export interface PageHit {
  book: string;
  page: number;
  chapter: string;
  section: string;
  score: number;
}

// 原文材料预算：按调用次数计费（除兜底 8B），但窗口有限，故限制页数与总字数
export const PAGE_CHAR_BUDGET = 12000;
const PAGE_MAX_PER_BOOK = 3;     // 命中页数（±1 扩展后实际最多 9 页/本）
const PAGE_GROUP_LIMIT = 4500;   // 合并块上限（约两页），避免一个连续大块吃光预算

/**
 * 用页级索引给问题打分，返回候选页（每本最多 PAGE_MAX_PER_BOOK 页）。
 * 打分：命中索引关键词 +3；关键词前缀命中（长词）+1；命中章/节标签 +2。
 * extraTerms：补充检索词（中文提问经模型翻译出的英文术语，弥补索引只有英文的问题）。
 */
export function retrievePages(
  indexes: PageIndexBook[],
  question: string,
  extraTerms: string[] = [],
): PageHit[] {
  const toks = [
    ...tokenize(question),
    ...extraTerms.map((t) => t.toLowerCase().trim()).filter(Boolean),
  ];
  if (!toks.length) return [];
  const hits: PageHit[] = [];
  for (const bk of indexes) {
    const byPage = new Map<number, PageHit>();
    const bump = (page: number, score: number, chapter: string, section: string) => {
      const prev = byPage.get(page);
      if (prev) {
        prev.score += score;
        if (!prev.section && section) prev.section = section;
      } else {
        byPage.set(page, { book: bk.book, page, chapter, section, score });
      }
    };

    // a) 页索引关键词打分（正文细节词靠这一层，如学者名、研究案例名）
    for (const e of bk.pages ?? []) {
      const kws = e.k ?? [];
      const label = `${e.s ?? ''} ${e.c ?? ''}`.toLowerCase();
      let s = 0;
      for (const t of toks) {
        if (t.length < 2) continue;
        if (kws.includes(t)) s += 3;
        else if (t.length >= 4 && kws.some((k) => k.startsWith(t))) s += 1;
        if (t.length >= 3 && label.includes(t)) s += 2;
      }
      if (s > 0) bump(e.p, s, e.c ?? '', e.s ?? '');
    }

    // b) Unit 标题命中：蒸馏层考点 ↔ 原书页码的直接指针，比关键词捞页更准，
    //    也让出处变成考点级（如 "Unit 5.1.2 · Marxist views on education"）。
    const unitEntries = Object.entries(bk.units ?? {});
    if (unitEntries.length) {
      const pageInfo = new Map<number, { c: string; s: string }>();
      for (const e of bk.pages ?? []) pageInfo.set(e.p, { c: e.c ?? '', s: e.s ?? '' });
      for (const [unit, u] of unitEntries) {
        const title = u.title.toLowerCase();
        let s = 0;
        for (const t of toks) {
          if (t.length >= 4 && title.includes(t)) s += 4;
          else if (t.length >= 3 && title.includes(t)) s += 2;
        }
        if (s > 0) bump(u.page, s, pageInfo.get(u.page)?.c ?? '', `Unit ${unit} · ${u.title}`);
      }
    }

    const list = [...byPage.values()].sort((a, b) => b.score - a.score);
    hits.push(...list.slice(0, PAGE_MAX_PER_BOOK));
  }
  return hits;
}

// ===== 答题脚手架（蒸馏层的教学口径）=====
// 按命中的章注入 system：给模型（尤其 8B 兜底档）一个结构模板，
// 并带上教师的失分点提醒（如教育题必须 material → cultural → in-school 分层）。
export interface ScaffoldRow {
  book: string;
  chapter: string;
  data: {
    'Mental Models'?: string;
    'Anti-patterns'?: string;
    'Key Takeaways'?: string;
  };
}

export function buildScaffoldText(rows: ScaffoldRow[], chapters: string[]): string {
  const ch = chapters.find((c) => c && rows.some((r) => r.chapter.toLowerCase() === c.toLowerCase()));
  if (!ch) return '';
  const row = rows.find((r) => r.chapter.toLowerCase() === ch.toLowerCase());
  const d = row?.data ?? {};
  const seg: string[] = [];
  if (d['Mental Models']) seg.push(`答题思路：\n${d['Mental Models']}`);
  if (d['Anti-patterns']) seg.push(`常见失分点（务必避免）：\n${d['Anti-patterns']}`);
  if (d['Key Takeaways']) seg.push(`要点：\n${d['Key Takeaways']}`);
  if (!seg.length) return '';
  return `【${ch} · 本章答题脚手架（教师口径，优先遵循）】\n${seg.join('\n')}`;
}

/** 命中页 ±1：一页常把论点切在中间，带上前后页保证论据完整。 */
export function expandPages(hits: PageHit[]): PageHit[] {
  const map = new Map<string, PageHit>();
  for (const h of hits) {
    for (const d of [-1, 0, 1]) {
      const p = h.page + d;
      if (p < 1) continue;
      const key = `${h.book}:${p}`;
      const score = h.score + (d === 0 ? 1 : 0);   // 核心页略加权，优先占用预算
      const prev = map.get(key);
      if (!prev || score > prev.score) map.set(key, { ...h, page: p, score });
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

interface PageGroup {
  book: string;
  pages: number[];
  chapter: string;
  section: string;
  score: number;
}

/** 把拉取到的页原文组装成材料块：同章连续页合并为一块，出处给页码范围，便于回查原书。 */
export function buildPageContext(
  hits: PageHit[],
  texts: Record<string, string>,   // `${book}:${page}` -> 原文
  bookLabel: Record<string, string>,
): { context: string; sources: string[] } {
  // 1) 按本分组，页内按页码升序，把同章连续页合并（跨页论点不再被切断）
  const groups: PageGroup[] = [];
  const byBook = new Map<string, PageHit[]>();
  for (const h of hits) byBook.set(h.book, [...(byBook.get(h.book) ?? []), h]);

  for (const [book, list] of byBook) {
    const avail = list
      .filter((h) => texts[`${book}:${h.page}`])
      .sort((a, b) => a.page - b.page);
    for (const h of avail) {
      const last = groups[groups.length - 1];
      const contiguous =
        last &&
        last.book === book &&
        last.chapter === h.chapter &&
        h.page - last.pages[last.pages.length - 1] <= 1;
      if (contiguous) {
        last.pages.push(h.page);
        last.score = Math.max(last.score, h.score);
      } else {
        groups.push({ book, pages: [h.page], chapter: h.chapter, section: h.section, score: h.score });
      }
    }
  }

  // 2) 按分数从高到低填入预算
  groups.sort((a, b) => b.score - a.score);
  const blocks: string[] = [];
  const sources: string[] = [];
  let used = 0;
  for (const g of groups) {
    if (used >= PAGE_CHAR_BUDGET) break;
    const label = bookLabel[g.book] ?? g.book;
    const where = [g.chapter, g.section].filter(Boolean).join(' › ');
    const range = g.pages.length > 1 ? `p.${g.pages[0]}-${g.pages[g.pages.length - 1]}` : `p.${g.pages[0]}`;
    const raw = g.pages.map((p) => texts[`${g.book}:${p}`]).join('\n');
    const piece = raw.slice(0, Math.min(raw.length, PAGE_GROUP_LIMIT));
    blocks.push(`【${label}${where ? ` › ${where}` : ''} › ${range}】\n${piece}`);
    sources.push(`${label} ${range}`);
    used += piece.length;
  }
  return { context: blocks.join('\n\n---\n\n'), sources };
}
