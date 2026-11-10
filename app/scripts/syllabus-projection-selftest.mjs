// 阶段 A 回归自检：确认 9699 行为与引入 syllabus 前逐条相等，并核对 0495 投影后的分布。
// 用法：node scripts/syllabus-projection-selftest.mjs
//
// 数据源：app/public/vocab-data.json（与云端 v101 同源，1024 条 = 9699 共享 902 + 0495 专属 122）。
//
// 注意：这里刻意复制了 src/lib/syllabus.ts 的投影口径而不是 import——
// 该模块是 TS，纯 node 跑不动；复制体量很小（30 行），
// 一旦改动 syllabus.ts 的 paperMap/快路径，请同步改本文件的 SYLLABI 常量。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const vocab = JSON.parse(fs.readFileSync(path.join(root, 'public', 'vocab-data.json'), 'utf8'));
// 0495 专属补充词条（带 syllabus:'0495'）：9699 侧必须一条都看不到
const supplement = vocab.filter((i) => i.syllabus === '0495');
// 9699 视角的基础词库（共享词条 = 没写 syllabus 字段的那些）
const native = vocab.filter((i) => i.syllabus !== '0495');
console.log(`词库：总计 ${vocab.length} 条 = 9699 共享 ${native.length} + 0495 专属 ${supplement.length}`);

const SYLLABI = {
  '9699': {
    id: '9699',
    papers: [
      { id: 'p1', tag: 'Paper 1' },
      { id: 'p2', tag: 'Paper 2' },
      { id: 'p3', tag: 'Paper 3' },
      { id: 'p4', tag: 'Paper 4' },
    ],
    paperMap: { 'Paper 1': 'p1', 'Paper 2': 'p2', 'Paper 3': 'p3', 'Paper 4': 'p4' },
  },
  '0495': {
    id: '0495',
    papers: [
      { id: 'p1', tag: 'Paper 1' },
      { id: 'p2', tag: 'Paper 2' },
    ],
    paperMap: { 'Paper 1': 'p1', 'Paper 2': 'p2', 'Paper 3': 'p2' },
    // 0495 不考学者姓名：学者词条整类不进 0495 视图（见 syllabus.ts 的 hideTypes）
    hideTypes: ['scholar'],
  },
};

function hiddenByType(item, syllabus) {
  return SYLLABI[syllabus]?.hideTypes?.includes(item.type) ?? false;
}

function paperTagFor(item, syllabus) {
  const def = SYLLABI[syllabus];
  const pid = def.paperMap[item.paper];
  if (!pid) return null;
  return def.papers.find((p) => p.id === pid)?.tag ?? null;
}

function projectItems(items, syllabus) {
  const def = SYLLABI[syllabus];
  const hides = def.hideTypes?.length ? def.hideTypes : null;
  if (def.id === '9699' && !hides) {
    // 9699：剔掉 syllabus='0495' 的专属词条，其余原样返回同一引用
    if (!items.some((i) => i.syllabus === '0495')) return items;
    return items.filter((i) => i.syllabus !== '0495');
  }
  const out = [];
  for (const i of items) {
    if (i.syllabus === '9699') continue;
    if (hiddenByType(i, syllabus)) continue;
    const tag = paperTagFor(i, syllabus);
    if (!tag) continue;
    out.push(tag === i.paper ? i : { ...i, paper: tag });
  }
  return out;
}

// 原始实现（引入 syllabus 前），逐字照抄以便对拍
function oldFilter(items, paper, cat, units = []) {
  return items.filter(
    (i) =>
      (paper === 'all' || i.paper === paper) &&
      (cat === 'all' || i.category === cat) &&
      (units.length === 0 || units.some((u) => (i.unit ?? []).includes(u))),
  );
}

// 新的「投影 + 原过滤」组合
function newFilter(items, paper, cat, units = [], syllabus = '9699') {
  return oldFilter(projectItems(items, syllabus), paper, cat, units);
}

let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    fail += 1;
    console.log(`FAIL ${name}\n  got      ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`);
  }
}

// 1) 9699 回归：所有 paper × category × 若干 unit 组合逐 id 相等
const papers = ['all', 'Paper 1', 'Paper 2', 'Paper 3', 'Paper 4'];
const cats = ['all', 'Family', 'Education', 'Globalisation', 'Media', ''];
const units = [[], ['研究方法'], ['家庭功能'], ['教育功能'], ['理论视角与核心概念']];
let combos = 0;
for (const p of papers) {
  for (const c of cats) {
    for (const u of units) {
      const a = oldFilter(native, p, c, u).map((i) => i.id);
      const b = newFilter(vocab, p, c, u, '9699').map((i) => i.id);
      check(`9699 ${p}/${c}/${u.join('+') || '-'}`, b, a);
      combos += 1;
    }
  }
}
console.log(`9699 回归：${combos} 个组合逐 id 对拍完成`);

// 2) 9699 投影在「没有 0495 专属词条」时必须返回同一数组引用（快路径，避免 memo 反复触发）
check('9699 projectItems 返回同一引用', projectItems(native, '9699') === native, true);

// 3) 0495 投影分布
const v0495 = projectItems(vocab, '0495');
const byPaper = {};
for (const i of v0495) byPaper[i.paper] = (byPaper[i.paper] ?? 0) + 1;
console.log('0495 投影后按卷：', byPaper);
const byCat = {};
for (const i of v0495) {
  const k = `${i.paper}|${i.category || '(空)'}`;
  byCat[k] = (byCat[k] ?? 0) + 1;
}
console.log('0495 投影后按卷+主题：', byCat);

// 4) 0495 不得出现 Paper 3 / Paper 4
const seen = [...new Set(v0495.map((i) => i.paper))].sort();
check('0495 卷名集合', seen, ['Paper 1', 'Paper 2']);

// 4b) 0495 条数必须等于 共享词条里 P1+P2+P3 的**术语** + 0495 专属（学者整类被 hideTypes 屏蔽）
const nativeCovered = native.filter(
  (i) => ['Paper 1', 'Paper 2', 'Paper 3'].includes(i.paper) && i.type !== 'scholar',
).length;
const nativeScholars = native.filter(
  (i) => ['Paper 1', 'Paper 2', 'Paper 3'].includes(i.paper) && i.type === 'scholar',
).length;
check('0495 条数 = 共享 P1+P2+P3 术语 + 专属', v0495.length, nativeCovered + supplement.length);
console.log(
  `共享 P1+P2+P3 术语 = ${nativeCovered}，0495 专属 ${supplement.length}，合计 ${v0495.length}` +
    `（另有 ${nativeScholars} 条学者被 0495 屏蔽）`,
);

// 4d) 0495 视图里不得出现任何学者词条（用户 m04004：0495 不考学者姓名）
check('0495 视图无学者词条', v0495.filter((i) => i.type === 'scholar').map((i) => i.term), []);

// 4c) 9699 看不到任何 0495 专属词条（回归关键）
const v9699 = projectItems(vocab, '9699');
check('9699 条数不受 0495 专属影响', v9699.length, native.length);
check('9699 里没有 syllabus=0495 的词条', v9699.some((i) => i.syllabus === '0495'), false);

// 4e) 屏蔽是视图层的，9699 仍然完整保留学者的全部 239 条
// （149 只是 P1–P3 那部分，P4 另有 90 条）
check('9699 学者条数不受影响', v9699.filter((i) => i.type === 'scholar').length, 239);

// 5) 同源词条 id 不变：0495 投影只改 paper，不新造 id
const ids9699 = new Set(native.map((i) => i.id));
const suppIds = new Set(supplement.map((i) => i.id));
const lostNative = [...new Set(v0495.map((i) => i.id))]
  .filter((id) => !ids9699.has(id))
  .filter((id) => !suppIds.has(id));
check('0495 投影未新造 id（除补充词条外）', lostNative, []);

// 6) 9699 的四卷条数与 v101 基线一致（回归断言，防 0495 专属词条污染）
// 注意：这是**共享词条**（syllabus 字段为空）的分布，不是 1024 条全量文件的分布
// ——全量文件里 0495 专属词条也占着 Paper 1/2/3 的 paper 值。
const baseline = { 'Paper 1': 316, 'Paper 2': 161, 'Paper 3': 133, 'Paper 4': 292 };
for (const [p, n] of Object.entries(baseline)) {
  check(`9699 ${p} 条数`, v9699.filter((i) => i.paper === p).length, n);
}
check('9699 总数', v9699.length, 902);

// 7) 0495 专属词条必须全部落在 P1/P2（否则投影会静默丢弃它）
const droppedSupp = supplement.filter((i) => !['Paper 1', 'Paper 2', 'Paper 3'].includes(i.paper));
check('0495 专属词条均在 P1–P3', droppedSupp.map((i) => i.term), []);

console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
