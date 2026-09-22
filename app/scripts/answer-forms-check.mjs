#!/usr/bin/env node
// 答案判定口径对拍体检：前端 normalizeKey（JS） vs 云端 normalize_answer（SQL）
//
// 为什么需要：服务端判定要求两边归一化严格等价，而 SQL 里最容易静默踩坑
// （PostgreSQL 的词边界是 \y 不是 \b、变音映射范围、-ise/-isation 的顺序）。
// 不一致的表现是「某个词学生明明写对了却判错」，只在个别词上偶发、极难发现，
// 所以必须靠对拍把它变成可检测的。
//
// 用法（在 app/ 下）：
//   node scripts/answer-forms-check.mjs
// 退出码：0 = 完全一致；1 = 存在不一致（需修 db-migration-answer-forms.sql）；2 = 环境/接口问题
//
// 相关文档：项目根《实时多人在线功能规划.md》第九节附

import fs from 'node:fs';
import path from 'node:path';

// ---- 与 app/src/lib/answers.ts 的 normalizeKey 逐字一致（改那边务必同步这里）----
function normalizeKey(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b([a-z]+?)isation\b/g, '$1ization')
    .replace(/\b([a-z]+?)ise\b/g, '$1ize')
    .replace(/[^a-z0-9]/g, '');
}

// ---- 单复数变体（复刻 answers.ts 的 toPlural / toSingular / singularPluralVariants）----
const IRREGULAR_PLURALS = { child: 'children', person: 'people', man: 'men', woman: 'women', foot: 'feet', tooth: 'teeth', mouse: 'mice', leaf: 'leaves', life: 'lives', wife: 'wives', analysis: 'analyses', criterion: 'criteria', phenomenon: 'phenomena', hypothesis: 'hypotheses', thesis: 'theses', index: 'indices', matrix: 'matrices' };
const IRREGULAR_SINGULARS = { children: 'child', people: 'person', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', mice: 'mouse', leaves: 'leaf', lives: 'life', wives: 'wife', analyses: 'analysis', criteria: 'criterion', phenomena: 'phenomenon', hypotheses: 'hypothesis', theses: 'thesis', indices: 'index', matrices: 'matrix', millenials: 'millennial' };
function toPlural(word) {
  const w = word.toLowerCase();
  if (IRREGULAR_PLURALS[w]) return IRREGULAR_PLURALS[w];
  if (/(ss|us|is)$/.test(w)) return null;
  if (/s$/.test(w)) return null;
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  if (/(x|z|ch|sh)$/.test(w)) return w + 'es';
  return w + 's';
}
function toSingular(word) {
  const w = word.toLowerCase();
  if (IRREGULAR_SINGULARS[w]) return IRREGULAR_SINGULARS[w];
  if (/ies$/.test(w) && w.length > 3) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return null;
  if (/(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (/es$/.test(w)) return w.slice(0, -1);
  if (/s$/.test(w)) return w.slice(0, -1);
  return null;
}
function singularPluralVariants(phrase) {
  const trimmed = String(phrase ?? '').trim();
  if (!trimmed) return [];
  const idx = trimmed.lastIndexOf(' ');
  const head = idx === -1 ? '' : trimmed.slice(0, idx + 1);
  const last = trimmed.slice(idx + 1);
  const out = [];
  const pl = toPlural(last);
  const sg = toSingular(last);
  if (pl) out.push(head + pl);
  if (sg) out.push(head + sg);
  return out;
}

// 控制台友好：非 ASCII 一律打码点，避免 Windows 控制台乱码看不清
const esc = (s) => JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// ---- 环境 ----
const envPath = path.join(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
  console.error('找不到 .env —— 请在 app/ 目录下运行：node scripts/answer-forms-check.mjs');
  process.exit(2);
}
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }),
);
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_ANON_KEY;

// ---- 构造测试输入 ----
const res = await fetch(`${URL_}/rest/v1/vocab_releases?select=version,data&order=version.desc&limit=1`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
});
if (!res.ok) {
  console.error('拉取词库失败：HTTP', res.status);
  process.exit(2);
}
const row = (await res.json())[0];
const items = row.data ?? [];

const inputs = new Set();
for (const it of items) {
  for (const s of [it.term, it.chinese, it.definition, ...(it.aliases ?? [])]) {
    if (s) inputs.add(String(s));
    for (const v of singularPluralVariants(String(s ?? ''))) inputs.add(v);
  }
}
// 定向变体：专打归一化的各个分叉
const manual = [
  '', '   ', '!!!', '...',
  'Globalisation', 'GLOBALISATION', 'globalization', 'globalisation ', ' globalisation',
  'global-isation', 'global_is_ation', 'deglobalisation', 'anti-globalisation',
  'Organisation', 'organise', 'organise!', 'organised', 'organiser',
  'Wise', 'wise', 'rise', 'promise', 'expertise', 'supervise', 'paradise',
  'Tiger & Fox', 'Tiger&Fox', 'A&B', '&', 'and',
  'café', 'Café', 'CAFÉ', 'naïve', 'résumé', 'piñata',
  'Sørensen', 'Straße', 'Æon', 'Œuvre', 'Đorđe', 'Þór', 'Łódź',
  'Ā', 'ā', 'ń', 'ő', 'ǔ', 'ș', 'ț',
  '家庭', '家庭 nuclear family', 'nuclear family 家庭',
  '19th century', 'A-Level', 'A Level', 'New Man', "'New Man'",
  'x'.repeat(300), ('globalisation '.repeat(20)).trim(),
];
manual.forEach((s) => inputs.add(s));

// 自动纳入全部「JS 处理后非空」的预组合字符：这是变音映射的风险面，
// 与 db-migration-answer-forms.sql 里的 translate 表同源；漏映射的字符会在这里暴露。
for (const [lo, hi] of [[0xa0, 0x2fff], [0x1e00, 0x1eff], [0xfb00, 0xfb06], [0x212b, 0x212b]]) {
  for (let cp = lo; cp <= hi; cp++) {
    const ch = String.fromCodePoint(cp);
    if (normalizeKey(ch)) inputs.add(ch);
  }
}

const list = [...inputs];
console.log(`对拍输入：${list.length} 条（词库 v${row.version}，${items.length} 词条；真实写法 + 单复数变体 + 定向变体）`);

// ---- SQL 侧：批量取结果 ----
const sqlResults = [];
const BATCH = 400;
for (let i = 0; i < list.length; i += BATCH) {
  const chunk = list.slice(i, i + BATCH);
  const r = await fetch(`${URL_}/rest/v1/rpc/normalize_answer_batch`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p: chunk }),
  });
  if (!r.ok) {
    const text = await r.text();
    console.error(`调用 normalize_answer_batch 失败：HTTP ${r.status}\n${text.slice(0, 400)}`);
    console.error('提示：请先在云端执行 db-migration-answer-forms.sql（内含 grant execute）。');
    process.exit(2);
  }
  const arr = await r.json();
  if (!Array.isArray(arr) || arr.length !== chunk.length) {
    console.error(`返回数量不匹配：请求 ${chunk.length} 条，返回 ${Array.isArray(arr) ? arr.length : typeof arr}`);
    process.exit(2);
  }
  sqlResults.push(...arr);
}

// ---- 比对 ----
const diffs = [];
list.forEach((input, i) => {
  const js = normalizeKey(input);
  const sql = sqlResults[i];
  if (js !== sql) diffs.push({ input, js, sql });
});

console.log(`一致：${list.length - diffs.length} / ${list.length}`);
if (diffs.length === 0) {
  console.log('结论：JS 与 SQL 归一化完全一致。');
  process.exit(0);
}

console.log(`\n不一致 ${diffs.length} 条，前 30 条：`);
for (const d of diffs.slice(0, 30)) {
  console.log(`  ${esc(d.input)}\n    JS  = ${esc(d.js)}\n    SQL = ${esc(d.sql)}`);
}
console.error('\n结论：存在不一致 —— 需修 db-migration-answer-forms.sql 的 normalize_answer()，重新执行后再跑本脚本。');
process.exit(1);
