// 教材知识站问答的检索 + prompt 组装
// 内容已整份在浏览器（登录后拉取），直接在本地做关键词/术语召回，无需服务端向量库
import { booksOf, type GlossaryEntry } from './data'
import type { SkillData } from './data'

// 语料会随挂载书目增长，材料宁精勿多：段数上限放宽、每段与总量收紧，
// 既避免超模型上下文，也减少无关段落稀释答案。
const MAX_PARTS = 8;            // 作为材料喂给模型的段落块上限
const PART_CHAR_LIMIT = 1000;   // 每段截断
const TOTAL_CHAR_BUDGET = 7000; // 材料总量上限（含术语块）

interface Hit {
  book: string;      // 书目名（用于出处标注）
  chapter: string;   // 章节名
  source: string;    // 完整出处：书目 › 章节 › 小节
  text: string;
  score: number;
}

// 从问题提取检索词：英文整词 + 中文双字组（去停用词）
function tokenize(q: string): string[] {
  const tokens = new Set<string>();
  const en = q.match(/[a-zA-Z][a-zA-Z\-']{1,}/g) ?? [];
  for (const w of en) if (w.length > 1) tokens.add(w.toLowerCase());
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

  // 1) 术语表命中（跨本；同名术语只保留一条，避免重复释义占额度）
  const seenTerms = new Set<string>();
  const hitTerms: { g: GlossaryEntry; book: string }[] = [];
  for (const b of books) {
    for (const g of b.glossary) {
      const hit =
        terms.some((t) => g.term.toLowerCase().includes(t)) || (g.zh.length >= 2 && q.includes(g.zh));
      if (!hit) continue;
      const key = g.term.toLowerCase();
      if (seenTerms.has(key)) continue;
      seenTerms.add(key);
      hitTerms.push({ g, book: b.label });
    }
  }
  const topTerms = hitTerms.slice(0, 8);

  // 2) 章节段落打分：先本内排序，再「每本保底一段 + 全局按分补齐」
  //    —— 否则篇幅大的教辅会把教材内容挤光
  const perBook: Hit[][] = books.map((b) => {
    const hits: Hit[] = [];
    for (const ch of b.chapters) {
      for (const sec of ch.sections) {
        const blob = `${sec.heading}\n${sec.lines.join('\n')}`;
        const lower = blob.toLowerCase();
        let score = 0;
        for (const t of terms) {
          let idx = lower.indexOf(t);
          let n = 0;
          while (idx !== -1 && n < 20) { n++; idx = lower.indexOf(t, idx + t.length); }
          if (n > 0) score += 1 + Math.min(n, 5);
        }
        // 术语章节回指加权：g.chapters 形如 ch01，需与章节 id 做包含判断
        for (const { g } of topTerms) {
          if (g.chapters.some((c) => ch.id.includes(c))) score += 3;
        }
        if (score > 0) {
          hits.push({
            book: b.label,
            chapter: ch.title,
            source: `${b.label} › ${ch.title} › ${sec.heading}`,
            text: blob.slice(0, PART_CHAR_LIMIT),
            score,
          });
        }
      }
    }
    hits.sort((a, b2) => b2.score - a.score);
    return hits;
  });

  const picked: Hit[] = [];
  for (const hits of perBook) if (hits.length) picked.push(hits[0]);
  const rest = perBook.flatMap((h) => h.slice(1));
  rest.sort((a, b2) => b2.score - a.score);
  picked.push(...rest);
  picked.sort((a, b2) => b2.score - a.score);

  // 按段数与总字数双重裁剪
  const top: Hit[] = [];
  let used = 0;
  for (const p of picked) {
    if (top.length >= MAX_PARTS) break;
    if (used + p.text.length > TOTAL_CHAR_BUDGET) break;
    used += p.text.length;
    top.push(p);
  }
  for (const p of top) sources.add(`${p.book} · ${p.chapter}`);

  // 3) 组装 context
  const blocks: string[] = [];
  if (topTerms.length) {
    sources.add('术语表');
    blocks.push(
      `【术语表命中】\n${topTerms
        .map(({ g, book }) =>
          `- ${g.term}（${g.def}）${g.chapters.length ? `[${g.chapters.join(', ')}]` : ''}${books.length > 1 ? `〔${book}〕` : ''}`,
        )
        .join('\n')}`,
    );
  }
  for (const p of top) blocks.push(`【${p.source}】\n${p.text}`);
  const context = blocks.join('\n\n---\n\n');

  // system：角色 + 教学口径（继承 SKILL.md 的答题人格）
  const system = `你是 Cambridge 9699 A Level 社会学教师助手，依据已挂载的多本教材与教辅蒸馏语料作答。

作答要求：
1. 严格依据提供的材料作答；材料未覆盖的内容明确说「知识库未覆盖」，绝不编造理论家、年份或研究。材料来自不同书目时，引用处注明书名。
2. 涉及理论判断时优先套用「理论归类指纹」：功能主义(Durkheim/Parsons，value consensus/social solidarity)、马克思主义(Marx/Bowles&Gintis，false consciousness/correspondence)、女权主义(patriarchy/intersectionality)、互动论(Mead/Blumer/Goffman，labelling/impression management)、后现代(Lyotard/Baudrillard，meta-narrative/hyperreality)。
3. 回答结构清晰：先给定义/结论，再给机制与证据（研究名+年份），涉及评估时正反两面并给出平衡结论（符合 AO1/AO2/AO3）。
4. 语言用简体中文为主，术语保留英文原词（如 meritocracy、secularisation）。
5. 中英术语可混查：如「文化资本」「cultural capital」都指 Bourdieu 的概念。`;

  return { system, context, sources: [...sources].slice(0, 8) };
}
