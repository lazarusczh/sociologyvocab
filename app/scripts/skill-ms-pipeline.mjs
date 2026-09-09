// 真题评分语料全量管线 v2：切题 md（考点骨架）× ms-data.json → 主题素材卡
// 配对策略：优先「卷+题号」精确 join；切题行无题号时用「同卷内题干词重叠」模糊配对；
//          该卷同 comp 内若 Evaluate/判断题唯一则直接配该题 ms。
// 用法: node scripts/skill-ms-pipeline.mjs
// 输出: app/data/ms-skill/cards/<Px>/<idx>-<slug>.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = join(import.meta.dirname, '..', '..');
const CARDS = join(rootDir, 'app/data/ms-skill/cards');

const PAPERS = [
  { slug: 'P1', file: 'Paper1真题-按考点.md', label: '理论·方法' },
  { slug: 'P2', file: 'Paper2真题-历年切题(至S26).md', label: '家庭' },
  { slug: 'P3', file: 'Paper3真题-历年切题(至S26).md', label: '教育' },
  { slug: 'P4G', file: 'Paper4Globalisation真题-历年切题(至S26).md', label: '全球化' },
  { slug: 'P4M', file: 'Paper4Media真题-历年切题(至S26).md', label: '媒体' },
];

// ms 索引： `${ses}|${qp}` → [{q, text, sigs}]
const MS = JSON.parse(readFileSync(join(rootDir, 'ms-data.json'), 'utf8'));
const compIndex = new Map();
for (const m of MS) {
  for (const s of m.sections ?? []) {
    const key = `${String(m.session).toLowerCase()}|${String(m.comp)}`;
    const arr = compIndex.get(key) ?? [];
    arr.push({ q: String(s.q).toLowerCase(), text: (s.text ?? '').trim() });
    compIndex.set(key, arr);
  }
}
const stop = new Set('a an the of to in for on with by at from as is are was were be been being it its this that these those they them their he she his her we our you your not do does did have has had and or but if which who whose what when where why how can could would should may might must about into than then also more most such only just'.split(' '));
const sigs = (s) => new Set((s ?? '').toLowerCase().match(/[a-z][a-z'\-]{2,}/g)?.filter((w) => !stop.has(w)) ?? []);
const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

const cleanInline = (s) =>
  (s ?? '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

const findHits = (line) => {
  const out = [];
  const re = /([MSW])(\d{2})\s+QP(\d{2})(?:\s*[/&]\s*QP(\d{2}))?(?:\s*Q\s*([0-9A-Za-z]+(?:\s*[（(]\s*[0-9A-Za-z]+\s*[）)])?))?/gi;
  let m;
  while ((m = re.exec(line))) {
    const ses = (m[1] + m[2]).toLowerCase();
    const q = (m[5] ?? '').toLowerCase();
    for (const qp of [m[3], m[4]].filter(Boolean)) out.push({ ses, qp, q });
  }
  return out;
};
const marksOf = (line) => {
  const mm = [...line.matchAll(/\[(\d+(?:\s*\+\s*\d+)?)\]\s*$/g)];
  return mm.length ? mm[mm.length - 1][1].replace(/\s+/g, '') : null;
};
const questionOf = (text) => {
  const i = text.search(/\nindicative content/i);
  const head = i === -1 ? text : text.slice(0, i);
  return head.split(/\r?\n/).filter(Boolean).join(' ').trim();
};
const pointsOf = (text) => {
  const i = text.search(/\nindicative content/i);
  if (i === -1) return [];
  const pts = [];
  for (const raw of text.slice(i).split(/\r?\n/)) {
    const t = raw.replace(/^\s*[•\-\*]\s*/, '').replace(/\s+/g, ' ').trim();
    if (!t || /^(total|max|award|level|mark|band|ao|accept|reject|credit|do not|no mark)\b/i.test(t)) continue;
    pts.push(t.slice(0, 240));
  }
  return [...new Set(pts)].slice(0, 12);
};

// 匹配：给定出处列表 + 题干，返回可用的 ms 内容（含题号），找不到返回 null
const matchMs = (hits, body) => {
  for (const h of hits) {
    if (!h.q) continue;
    const key = `${h.ses}|${h.qp}`;
    const arr = compIndex.get(key) ?? [];
    const one = arr.find((x) => x.q === h.q);
    if (one) return { id: `${h.ses} QP${h.qp} Q${h.q}`, text: one.text };
  }
  // 无题号：同卷同 comp 内按题干词重叠择优；Evaluate/判断题唯一则直接取
  for (const h of hits) {
    const arr = compIndex.get(`${h.ses}|${h.qp}`) ?? [];
    if (!arr.length) continue;
    const sb = sigs(body);
    let best = null, bestN = 0, second = 0;
    for (const x of arr) {
      const n = overlap(sb, sigs(questionOf(x.text)));
      if (n > bestN) { second = bestN; bestN = n; best = x; }
      else if (n === bestN && n > 0) second = bestN;
    }
    if (bestN >= 3 && bestN > second) {
      return { id: `${h.ses} QP${h.qp}${best.q ? ' Q' + best.q : ''}`, text: best.text };
    }
    if (bestN >= 2 && arr.length === 1) {
      return { id: `${h.ses} QP${h.qp}${best.q ? ' Q' + best.q : ''}`, text: best.text };
    }
  }
  return null;
};

const out = { papers: {} };
for (const P of PAPERS) {
  const md = readFileSync(join(rootDir, P.file), 'utf8');
  const topics = [];
  let cur = null;
  const flush = () => { if (cur && cur.items.length) topics.push(cur); cur = null; };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#/.test(line)) {
      const lvl = line.match(/^#+/)[0].length;
      const head = cleanInline(line.replace(/^#+\s*/, '').replace(/\[\d[\d+\s]*\]$/, ''));
      if (lvl === 2) { flush(); cur = { path: [head], items: [] }; }
      else if (lvl >= 3 && cur) { const p = cur.path.slice(0, lvl - 2); p[lvl - 2] = head; cur.path = p; }
      continue;
    }
    if (/^[-*]\s/.test(line) && cur) {
      const body = line.replace(/^[-*]\s+/, '');
      const marks = marksOf(body) ?? marksOf(line);
      // 高价值两类：① Evaluate 大分题 / 10+6 判断；② 6-8 分的 strengths-limitations Explain 小问
      // （2(b) 型，如 "Explain one strength and one limitation of X view. [6]"——实战易因没突出体现 strength 失分）
      const isEssay = /evaluate/i.test(body) || (marks && (/\+/.test(marks) || parseInt(marks, 10) >= 20));
      const isSL =
        !!marks &&
        !marks.includes('+') &&
        parseInt(marks, 10) <= 8 &&
        /(?:one|two)\s+(?:strength|limitation|advantage|disadvantage)|strengths?\s+and\s+limitations?/i.test(body);
      const isHigh = isEssay || isSL;
      const hits = findHits(line);
      if (!isHigh || !hits.length) continue;
      const qtext = cleanInline(body.replace(/\[\d+(?:\s*\+\s*\d+)?\]$/, '').replace(/^[‘']|’?\s*$/g, ''));
      const mm = matchMs(hits, qtext);
      cur.items.push({
        q: qtext.slice(0, 280),
        marks: marks ?? '',
        src: hits.map((h) => `${h.ses} QP${h.qp}${h.q ? ' Q' + h.q : ''}`).join('; '),
        ms: mm ? { id: mm.id, points: pointsOf(mm.text) } : null,
      });
    }
  }
  flush();
  out.papers[P.slug] = { label: P.label, topics: topics.map((t) => ({ title: t.path.filter(Boolean).join(' › '), items: t.items })) };

  mkdirSync(join(CARDS, P.slug), { recursive: true });
  topics.forEach((t, i) => {
    const title = t.path.filter(Boolean).join('-');
    const slug = title.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'topic';
    writeFileSync(join(CARDS, P.slug, `${i + 1}-${slug}.json`), JSON.stringify({ title: t.path.filter(Boolean).join(' › '), items: t.items }, null, 1), 'utf8');
  });

  const all = topics.flatMap((t) => t.items);
  const withMs = all.filter((x) => x.ms);
  console.log(`\n[${P.slug}] ${P.label}：主题 ${topics.length}，高价值题 ${all.length}（ms 命中 ${withMs.length} / 未命中 ${all.length - withMs.length}）`);
  for (const t of topics) {
    const tt = t.path.filter(Boolean).join(' › ');
    console.log(`  · ${tt}：${t.items.length} 题，ms ${t.items.filter((i) => i.ms).length} 配`);
  }
  const miss = all.filter((x) => !x.ms);
  if (miss.length) console.log(`  ⚠ 未配 ms：${miss.slice(0, 4).map((x) => x.q.slice(0, 58)).join(' | ')}`);
}
console.log(`\n素材卡目录：${CARDS}`);
