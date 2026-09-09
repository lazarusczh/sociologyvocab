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

  // 2) 章节段落打分：先本内排序，再「每本保底一段 + 全局按分补齐」
  //    —— 否则篇幅大的教辅会把教材内容挤光
  const perBook: Hit[][] = books.map((b) => {
    const hits: Hit[] = [];
    for (const ch of b.chapters) {
      // 独立宗教主题章默认跳过检索（选修不教）；问题明确指向宗教领域时才放行
      if (isReligionTopic(ch) && !REL_SIGNAL.test(q)) continue;
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
  const system = `你是 Cambridge 9699 A Level 社会学教师助手，依据已挂载的多本教材与教辅蒸馏语料作答。

作答要求：
1. 严格依据材料作答，不得编造理论家/年份/研究；材料未覆盖处明确说「知识库未覆盖」。引用书名用简称（《Haralambos》《Livesey & Blundell》，材料块首行已标来源）。
2. 主体作答务必完整、有信息量：先给定义或核心结论，再展开机制与证据（含研究名+年份），需要时正反评价并给平衡结论（对应 AO1/AO2/AO3）。禁止只给一句话术语释义、禁止把英文概念翻译成中文就算回答。概念/理论题请把主体展开到约 300–500 字（书际差异补充段另计）；若答得太短通常意味着漏了机制或证据，请按材料补全。
3. 涉及理论判断先归位「理论指纹」：功能主义(Durkheim/Parsons，value consensus/social solidarity)、马克思主义(Marx/Bowles&Gintis，correspondence principle/false consciousness)、女权主义(patriarchy/intersectionality)、互动论(Mead/Blumer/Goffman，labelling/impression management)、后现代(Lyotard/Baudrillard，simulacra/meta-narrative)。
4. 两书差异作为「补充段」放在主体之后（不是回答的主结构）：主体完整展开后，若两本及以上都覆盖同一问题，用一小段说明两书侧重——先一句共同点，再简短分列各书差异或出入，指出分歧可作为 AO3 评估点。不要为了对比而压缩主体；只有一本覆盖时就按该书如实作答。
5. 语言用简体中文为主，术语保留英文原词（如 meritocracy、secularisation）；中英术语可混查（如「文化资本」「cultural capital」均指 Bourdieu 概念）。`;

  return { system, context, sources: [...sources].slice(0, 8) };
}
