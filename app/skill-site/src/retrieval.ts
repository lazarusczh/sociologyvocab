// 教材知识站问答的检索 + prompt 组装
// 内容已整份在浏览器（登录后拉取），直接在本地做关键词/术语召回，无需服务端向量库
import type { SkillData } from './data'

const MAX_PARTS = 6;          // 作为材料喂给模型的段落块上限
const PART_CHAR_LIMIT = 2600; // 每段截断，控制单次 token

interface Hit { source: string; text: string; score: number }

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
  const sources = new Set<string>();

  // 1) 术语表命中（整词包含）
  const ql = q.toLowerCase();
  const hitTerms = skill.glossary.filter(
    (g) => terms.some((t) => g.term.toLowerCase().includes(t)) || g.zh.length >= 2 && q.includes(g.zh),
  ).slice(0, 8);

  // 2) 章节段落打分
  const parts: Hit[] = [];
  for (const ch of skill.chapters) {
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
      // 术语章节回指加权：命中术语所在章加强
      for (const g of hitTerms) {
        if (g.chapters.includes(ch.id)) score += 3;
      }
      if (score > 0) {
        parts.push({
          source: `${ch.title} › ${sec.heading}`,
          text: blob.slice(0, PART_CHAR_LIMIT),
          score,
        });
      }
    }
  }
  parts.sort((a, b) => b.score - a.score);
  const top = parts.slice(0, MAX_PARTS);
  for (const p of top) sources.add(p.source.split(' › ')[0]);

  // 3) 组装 context
  const blocks: string[] = [];
  if (hitTerms.length) {
    sources.add('术语表');
    blocks.push(`【术语表命中】\n${hitTerms.map((g) => `- ${g.term}（${g.def}）${g.chapters.length ? `[${g.chapters.join(', ')}]` : ''}`).join('\n')}`);
  }
  for (const p of top) blocks.push(`【${p.source}】\n${p.text}`);
  const context = blocks.join('\n\n---\n\n');

  // system：角色 + 教学口径（继承 SKILL.md 的答题人格）
  const system = `你是 Cambridge 9699 A Level 社会学教师助手，服务于教材《Cambridge International AS & A Level Sociology》(Haralambos et al. 2019) 的知识问答。

作答要求：
1. 严格依据提供的教材材料作答；材料未覆盖的内容明确说「知识库未覆盖」，绝不编造理论家、年份或研究。
2. 涉及理论判断时优先套用「理论归类指纹」：功能主义(Durkheim/Parsons，value consensus/social solidarity)、马克思主义(Marx/Bowles&Gintis，false consciousness/correspondence)、女权主义(patriarchy/intersectionality)、互动论(Mead/Blumer/Goffman，labelling/impression management)、后现代(Lyotard/Baudrillard，meta-narrative/hyperreality)。
3. 回答结构清晰：先给定义/结论，再给机制与证据（研究名+年份），涉及评估时正反两面并给出平衡结论（符合 AO1/AO2/AO3）。
4. 语言用简体中文为主，术语保留英文原词（如 meritocracy、secularisation）。
5. 中英术语可混查：如「文化资本」「cultural capital」都指 Bourdieu 的概念。`;

  return { system, context, sources: [...sources].slice(0, 8) };
}
