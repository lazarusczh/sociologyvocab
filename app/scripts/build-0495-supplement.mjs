// 把 125 条 0495 glossary 补充词条组装成完整 VocabItem，供入库（VocabManager 导入 / 发布）使用。
//
// 输入：
//   app/scripts/_0495_supplement.json          —— term / topic / definition（英文逐字取自官方 glossary）
//   0495补词与中文释义-待审.md                  —— 第 1 批 22 条中文
//   0495补词与中文释义-第2-5批.md               —— 第 2–5 批 103 条中文
// 输出：
//   app/scripts/_0495_vocab_items.json         —— VocabItem[]（可直接导入）
//
// 用法：node scripts/build-0495-supplement.mjs
//
// 关键约定：
//   · paper 沿用 9699 的原生卷名（补充词条不改卷结构，投影交给 syllabus.ts）
//   · category 用该 topic 在 9699 里的真实 category（'' / Family / Education），
//     这样 0495 视图里的主题分组与现有词条天然合并，不需要额外映射表
//   · 用 syllabus:'0495' 字段标记「只属于 0495」，9699 侧据此排除（见 syllabus.ts visibleItems）
//   · unit 尽量贴近现有细粒度单元，让 0495 视图的单元筛选不至于全挤在一个桶里
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const projRoot = path.resolve(root, '..');

const supplement = JSON.parse(fs.readFileSync(path.join(root, 'scripts', '_0495_supplement.json'), 'utf8'));

// ---- 中文释义：从两份 md 的表格里抽 ----
//
// 表格里写的是「**术语名**：一句话解释。」两段内容，但 VocabItem.chinese 在现有 889 条里
// 一律是**短译名**（平均 4.8 字，最长 14 字），并且被三处当短标签用：
//   · quiz.ts 的 cn2term 方向直接拿 chinese 当题干（整段解释会变成送分题）
//   · Flashcards 背面的大字、Dictionary 的词条副标题
//   · answers.ts 把 chinese 当作可接受答案之一
// 所以这里只取冒号前的术语名进 chinese，解释另存一份备查，不塞进词条。
function parseChinese(file) {
  const text = fs.readFileSync(path.join(projRoot, file), 'utf8');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // 形如 ['', '1', 'Age', 'definition', '**年龄**：...', ''] —— 去掉首尾空串
    if (cells.length < 6) continue;
    const idx = cells[1];
    if (!/^\d+$/.test(idx)) continue; // 跳过表头与分隔行
    const term = cells[2];
    const cell = cells[4];
    if (!term || !cell) continue;
    const m = cell.match(/^\*\*(.+?)\*\*\s*[：:]\s*(.+)$/);
    if (!m) {
      map.set(term.trim().toLowerCase(), { name: cell, note: '' });
      continue;
    }
    map.set(term.trim().toLowerCase(), { name: m[1].trim(), note: m[2].trim() });
  }
  return map;
}

const zh1 = parseChinese('0495补词与中文释义-待审.md');
const zh2 = parseChinese('0495补词与中文释义-第2-5批.md');
const chinese = new Map([...zh1, ...zh2]);

// ---- topic → 卷 / 主题 ----
// '' 表示 9699 里 Paper 1 的词条 category 就是空串（研究方法/身份/分层同卷不分 category）
const TOPIC_PAPER = {
  methods: { paper: 'Paper 1', category: '', unit: '研究方法' },
  identity: { paper: 'Paper 1', category: '', unit: '社会认同基础' },
  strat: { paper: 'Paper 1', category: '', unit: '阶级认同' },
  family: { paper: 'Paper 2', category: 'Family', unit: '家庭多样性' },
  education: { paper: 'Paper 3', category: 'Education', unit: '教育功能' },
};

// 细粒度单元覆盖：把能明确归到某个既有单元的术语挑出来，
// 剩下的仍落在 topic 默认单元里（不做过度猜测，归错反而更糟）
const UNIT_HINTS = [
  { unit: '性别认同', test: /\b(gender|sex|sexism|patriarch|femin|masculin)\w*/i },
  { unit: '族裔认同', test: /\b(ethnic|race|racial|racism|racist|minority)\w*/i },
  { unit: '年龄认同', test: /\b(age|ageism|childhood|youth|elderly|old age)\w*/i },
  { unit: '研究设计', test: /\b(hypothes|questionnaire|interview|sampl|survey|observation|experiment|longitudinal|case study)\w*/i },
  { unit: '研究方法', test: /\b(data|reliab|valid|triangulat|statistic|ethnograph|document)\w*/i },
  { unit: '方法论取向', test: /\b(positiv|interpretiv|realis|functionalis|marxis|feminist)\w*/i },
];

function unitFor(term, topic) {
  const base = TOPIC_PAPER[topic];
  if (!base) throw new Error(`未知 topic: ${topic}`);
  // 只有 P1 的三个 topic 共享同一 category，才需要靠 unit 区分；家庭/教育本身 category 已区分
  if (base.category) return base.unit;
  for (const h of UNIT_HINTS) if (h.test.test(term)) return h.unit;
  return base.unit;
}

// ---- stableId：与 app/src/lib/shuffle.ts 逐字同源（复制，改动请同步） ----
//
// ⚠ 2026-11-10 修：此前这里写的是一个 FNV 变体，跟 shuffle.ts 的「双 djb2」完全不同，
//   导致生成的 id 与云端既有词条对不上 —— 同名同卷同主题的词会变成两条不同 id 的记录，
//   进度/错题本共享立刻断裂。现在逐字照抄 shuffle.ts:44-57。
function stableId(type, term, paper, category, units) {
  const unitKey = units && units.length ? units.slice().sort().join(',') : '';
  const key = [type, term.trim().toLowerCase(), paper, category, unitKey].join('||');
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = (Math.imul(h1, 33) + c) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return `${type === 'scholar' ? 'sch' : 'term'}_${h1.toString(36)}${h2.toString(36)}`;
}

// ---- 组装 ----
const existing = JSON.parse(fs.readFileSync(path.join(root, 'public', 'vocab-data.json'), 'utf8'));
const existingIds = new Map(existing.map((i) => [i.id, i]));
const existingTermKey = new Map();
for (const i of existing) {
  const k = `${i.term.trim().toLowerCase()}|${i.paper}|${i.category}`;
  if (!existingTermKey.has(k)) existingTermKey.set(k, i);
}

const items = [];
const problems = [];
const unitDist = {};
for (const s of supplement) {
  const base = TOPIC_PAPER[s.topic];
  if (!base) {
    problems.push(`未知 topic: ${s.term} → ${s.topic}`);
    continue;
  }
  const zh = chinese.get(s.term.trim().toLowerCase());
  if (!zh) problems.push(`缺中文: ${s.term}`);
  const unit = unitFor(s.term, s.topic);
  unitDist[unit] = (unitDist[unit] ?? 0) + 1;
  const id = stableId('term', s.term, base.paper, base.category, [unit]);

  if (existingIds.has(id)) {
    problems.push(`id 与现有词条冲突: ${s.term} → ${existingIds.get(id).term} (${id})`);
  }
  const dupKey = `${s.term.trim().toLowerCase()}|${base.paper}|${base.category}`;
  if (existingTermKey.has(dupKey)) {
    problems.push(`同名同卷同主题已存在: ${s.term} → ${existingTermKey.get(dupKey).term}`);
  }

  items.push({
    id,
    type: 'term',
    term: s.term,
    chinese: zh?.name ?? '',
    definition: s.definition,
    paper: base.paper,
    category: base.category,
    unit: [unit],
    syllabus: '0495',
  });
}

// ---- 报告 ----
console.log(`补充词条：${items.length} 条（源 ${supplement.length} 条）`);
console.log('按单元：', unitDist);
const byCat = {};
for (const i of items) {
  const k = `${i.paper}|${i.category || '(空)'}`;
  byCat[k] = (byCat[k] ?? 0) + 1;
}
if (problems.length) {
  console.log(`\n⚠ 问题 ${problems.length} 条：`);
  for (const p of problems) console.log('  -', p);
} else {
  console.log('\n无 id 冲突、无重名、中文齐全');
}

// 译名长度体检：现有词库 chinese 平均 4.8 字、最长 14 字，
// 超过 14 字会挤坏 Flashcards 大字排版，也说明这一条可能没被抽成短译名。
const longNames = items.filter((i) => i.chinese.length > 14);
const noName = items.filter((i) => !i.chinese);
console.log(`译名长度：平均 ${(items.reduce((s, i) => s + i.chinese.length, 0) / items.length).toFixed(1)} 字`,
  `最长 ${Math.max(...items.map((i) => i.chinese.length))} 字`);
if (longNames.length) {
  console.log(`⚠ ${longNames.length} 条译名偏长（>14 字）：`);
  for (const i of longNames) console.log(`  - ${i.term} → ${i.chinese}`);
}
if (noName.length) console.log(`⚠ ${noName.length} 条无中文`);

fs.writeFileSync(path.join(root, 'scripts', '_0495_vocab_items.json'), `${JSON.stringify(items, null, 2)}\n`, 'utf8');
// 中文解释原文另存，供 VocabManager 里手工补 notes / 后续出「释义中文化」时用；不进词库
const notes = [];
for (const s of supplement) {
  const zh = chinese.get(s.term.trim().toLowerCase());
  if (zh) notes.push({ term: s.term, chinese: zh.name, note: zh.note });
}
fs.writeFileSync(path.join(root, 'scripts', '_0495_chinese_notes.json'), `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
console.log('\n写出 app/scripts/_0495_vocab_items.json');
console.log('写出 app/scripts/_0495_chinese_notes.json（中文解释原文，不进词库）');
