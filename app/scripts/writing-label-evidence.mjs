// 写作练习·位置标签取证器（多源）
// 为每个「概念组」汇总多来源证据，输出 JSONL，供 LLM 判定 peelRole 或教师审校。
//
// 用法：
//   node scripts/writing-label-evidence.mjs --units 家庭,性别 --limit 20 --out out/ev-family.jsonl
//   node scripts/writing-label-evidence.mjs --local --only "Conjugal role"
//   node scripts/writing-label-evidence.mjs --all --out out/ev-all.jsonl
//
// 证据源（每一条标签都必须能指回这里）：
//   1) 词条自身      type / definition / chinese / unit / theories
//   2) 逻辑关系图谱  higher / lower / peer / contrast（只存在于云端发布版本，本机兜底库为空）
//   3) 真题 ms 章    命中在「支持方证据链 / 反方弹药 / 高分收尾」哪一节
//   4) 教材 skill    glossary / patterns / cheatsheet / chapters 命中位置
//   5) 待联网核实    三源皆无命中 或 释义过短/可疑 的条目会被标记
//
// 归组规则直接复用前端 conceptIdOf（esbuild 打包后 import），不重写归一化逻辑。
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const SKILLS_DIR = process.env.SKILLS_DIR || 'C:/Users/rebir/.agents/skills';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--local' || a === '--all' || a === '--verbose') args[a.slice(2)] = true;
  else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
}
const wantUnits = (args.units ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = args.limit ? Number(args.limit) : (args.all ? Infinity : 20);
const ONLY = args.only ?? '';
const SAMPLE_FROM = args.from ? Number(args.from) : 0;

// ---------- 复用前端逻辑（归组 + 学者姓氏） ----------
const tmp = mkdtempSync(join(tmpdir(), 'lbl-'));
const bundle = join(tmp, 'relationSuggest.mjs');
execSync(
  `npx esbuild src/lib/relationSuggest.ts --bundle --format=esm --outfile=${bundle} --log-level=error`,
  { stdio: 'inherit', cwd: APP_DIR },
);
const { conceptIdOf } = await import(pathToFileURL(bundle).href);

const bundleAns = join(tmp, 'answers.mjs');
execSync(
  `npx esbuild src/lib/answers.ts --bundle --format=esm --outfile=${bundleAns} --log-level=error`,
  { stdio: 'inherit', cwd: APP_DIR },
);
const { scholarSurnames } = await import(pathToFileURL(bundleAns).href);

// ---------- 词库（云端优先，本机兜底） ----------
async function loadVocab() {
  if (args.local) {
    const items = JSON.parse(readFileSync(join(APP_DIR, 'public/vocab-data.json'), 'utf8'));
    console.log(`[vocab] LOCAL public/vocab-data.json  items=${items.length}`);
    return { version: 0, items };
  }
  const env = {};
  const envPath = join(APP_DIR, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in app/.env');
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(url, key);
  const { data, error } = await sb
    .from('vocab_releases')
    .select('version, data')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('vocab_releases is empty');
  console.log(`[vocab] CLOUD vocab_releases v${data.version}  items=${data.data.length}`);
  return { version: data.version, items: data.data };
}

// ---------- 语料（ms 章 + 教材） ----------
// 行首标记：ms 的侧别线索在 bullet 自己的行首（如「主张内核：」「反驳（…）：」），
// 而不是小节标题 —— 标题常并列两侧（如「马克思主义族（主张与反驳）」）。
function leadLabel(text) {
  const t = text.replace(/^\s*([-*]|\d+\.)\s+/, '');
  const m = t.split(/[：:]/)[0];
  return (m.length <= 30 ? m : m.slice(0, 30)).trim();
}

// 语料切分：按标题分节，节内**按 bullet 逐条**成单元（保留原文顺序）。
// bullet 级是必需的粒度：① snippet 更准；② 侧别线索在行首；③ 同一引文可能在同一节内两侧并用。
function loadSections(file, source, kind) {
  const out = [];
  let heading = '(intro)';
  let items = [];   // 按原始顺序：{t:'p'|'b', text}
  let para = [];
  const pushPara = () => {
    const t = para.join('\n').trim();
    if (t) items.push({ t: 'p', text: t });
    para = [];
  };
  const flush = () => {
    pushPara();
    for (const it of items) {
      out.push({ source, kind, file: basename(file), heading, text: it.text, label: leadLabel(it.text) });
    }
    items = [];
  };
  for (const ln of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const h = ln.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); heading = h[1].trim(); continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(ln)) { pushPara(); items.push({ t: 'b', text: ln.trim() }); }
    else para.push(ln);
  }
  flush();
  return out;
}

function loadCorpus() {
  const out = [];
  const add = (dir, kind, files) => {
    for (const f of files) {
      const p = join(dir, f);
      if (existsSync(p)) out.push(...loadSections(p, `${kind}:${f}`, kind));
    }
  };
  // 真题评分视角（每章含 支持方证据链 / 反方弹药 / 高分收尾）
  // 注意：ms 的「支持 / 反方」是**相对该章核心主张**而言的，所以把章级 Core Idea 一起采集，
  //      否则侧别无法解释（同一词条在不同章的同一侧，可能对应相反的立场）。
  const msDir = join(SKILLS_DIR, '9699papers-ms', 'chapters');
  if (existsSync(msDir)) {
    for (const f of readdirSync(msDir).filter((x) => x.endsWith('.md'))) {
      const secs = loadSections(join(msDir, f), `ms:${f}`, 'ms');
      const coreUnits = secs.filter((s) => /Core Idea/i.test(s.heading));
      const claim = coreUnits.length
        ? coreUnits[0].text.replace(/^\s*([-*]|\d+\.)\s+/, '').slice(0, 240)
        : '';
      for (const s of secs) s.claim = claim;
      out.push(...secs);
    }
  }
  // 教材两本（glossary 中英对照 + patterns 答题套路 + chapters 正文）
  for (const [book, name] of [['9699textbook1', 'tb1-haralambos'], ['9699textbook2', 'tb2-livesey']]) {
    const base = join(SKILLS_DIR, book);
    if (!existsSync(base)) continue;
    add(base, name, ['glossary.md', 'patterns.md', 'cheatsheet.md', 'SKILL.md']);
    const chDir = join(base, 'chapters');
    if (existsSync(chDir)) add(chDir, name, readdirSync(chDir).filter((f) => f.endsWith('.md')));
  }
  return out;
}

// ---------- 匹配 ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 通用尾词：词条名常带 "Theory / Model / Approach" 等，构成多词精确匹配时会漏掉正文里的核心短语
// （如 "'Warm bath' Theory" 正文只写 warm bath）。构建"核心短语"匹配器时剔除。
const GENERIC_WORDS = new Set([
  'theory', 'model', 'approach', 'concept', 'perspective', 'view', 'thesis',
  'the', 'of', 'and', 'a', 'an', 'in', 'on', 'for', 'to', 'as',
]);

// 词形宽松：每个词允许尾部 s/es/ies/ing/ed；多词之间允许空格或连字符。
// 返回多组匹配器：全词形 + 核心短语（去掉引号、通用尾词后）。
function makeMatchers(term, chineses, extraForms = []) {
  const matchers = [];
  const words = term.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const core = words.filter((w) => !GENERIC_WORDS.has(w));
  const specs = [];
  if (words.length) specs.push({ form: 'full', words });
  if (core.length && core.length !== words.length) specs.push({ form: 'core', words: core });
  // 学者姓氏（正文通常只写姓）：scholarSurnames 对合著者会产出 "(" / "Beck-Gernsheim)" 之类的脏值，先清洗
  for (const w of extraForms) {
    if (/^[a-z][a-z'-]{2,}$/i.test(w)) specs.push({ form: 'surname', words: [w.toLowerCase()] });
  }
  for (const s of specs) {
    const body = s.words.map((w) => esc(w) + '(?:s|es|ies|ing|ed)?').join('[\\s\\-]+');
    matchers.push({ label: 'en', form: s.form, re: new RegExp('\\b' + body + '\\b', 'i') });
  }
  for (const c of chineses) {
    if (c && c.length >= 2) matchers.push({ label: 'zh', form: 'zh', re: new RegExp(esc(c), 'i') });
  }
  return matchers;
}

// 单词词条（如 Alternative / Privacy）在正文里命中泛词的概率高，需要标注"命中可信度低"
const isSingleWord = (term) => (term.toLowerCase().match(/[a-z0-9]+/g) ?? []).length === 1;

function snippet(text, re) {
  const m = re.exec(text);
  if (!m) return '';
  const i = m.index;
  const s = Math.max(0, i - 110);
  const e = Math.min(text.length, i + m[0].length + 150);
  return (s > 0 ? '…' : '') + text.slice(s, e).replace(/\s+/g, ' ').trim() + (e < text.length ? '…' : '');
}

// 落盘时压缩 ms 命中：**优先保证 (章, 侧别) 的多样性** ——
// 同一引文在"主张"与"反驳"两处都出现正是需要保留的信息，不能被同章同类命中挤掉。
function compressMs(hits, max = 16) {
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const k = `${h.source}|${h.role}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
    if (out.length >= max) return out;
  }
  for (const h of hits) {
    if (out.length >= max) break;
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

// ---------- ms 小节归类（支持方 / 反方 / 收尾 / 其他） ----------
// 注意：ms 章的「支持 / 反方」是相对该章核心主张而言的。
// 标题常同时含两类词（如「反方「家庭已趋平等」的证据链」），按左侧最早出现的关键词判定。
const SIDE_PATTERNS = [
  ['oppose', /反方|反驳|批评|critiq|局限|削弱|挑战|质疑|不成立/i],
  ['support', /支持|证据链|AO1|AO2|论题一|论题二|主张|弹药|有利/i],
  ['conclusion', /收尾|结论|高分|加分|失分|平衡句/i],
  ['pastpaper', /真题|速查|回顾/i],
];
// "两手都摆"型 bullet（如「平衡题（如 S26 ms）…」）——它本身就是**同题双面**的信号，
// 既不是 support 也不是 oppose，单列一类，避免污染侧别统计。
const BALANCED_RE = /平衡|两面|双刃|各有利弊|利弊|正面.{0,8}负面/i;

function msRole(heading, label = '') {
  if (label && BALANCED_RE.test(label)) return 'balanced';
  // 先看 bullet 自己的行首标记（最贴近语义）；没有才回退到小节标题
  for (const src of [label, heading]) {
    if (!src) continue;
    let best = null;
    for (const [role, re] of SIDE_PATTERNS) {
      const m = re.exec(src);
      if (m && (!best || m.index < best.index)) best = { role, index: m.index };
    }
    if (best) return best.role;
  }
  return 'other';
}

// ---------- 侧别推导：side = f(词条, 题干) ----------
// ms 给出的侧别是**相对该章核心主张**的（sideInChapter）。要得到"该词条在给定题干下的侧别"，
// 必须先判断题干与该章 claim 是否同向 —— 这一步是语义判断，由 LLM/教师给出 —— 再按同向沿用 / 反向翻转。
// **side 不得作为词条级标签缓存。**
function sideForHit(sideInChapter, statementAlignedWithClaim) {
  if (sideInChapter === 'support' || sideInChapter === 'oppose') {
    if (statementAlignedWithClaim) return sideInChapter;
    return sideInChapter === 'support' ? 'oppose' : 'support';
  }
  return sideInChapter;   // conclusion / pastpaper / other 不翻转（非立场性引用）
}

// ---------- 主流程 ----------
const { version, items } = await loadVocab();
const byId = new Map(items.map((i) => [i.id, i]));
const termOfId = (id) => byId.get(id)?.term ?? null;

// 概念组归并（复用前端规则）
const groups = new Map();
for (const it of items) {
  const cid = conceptIdOf(it);
  if (!groups.has(cid)) groups.set(cid, []);
  groups.get(cid).push(it);
}

// 过滤
let keys = [...groups.keys()];
const pickGroup = (cid) => {
  const members = groups.get(cid);
  const term = members[0].term;
  const units = [...new Set(members.flatMap((m) => m.unit ?? []))];
  return { members, term, units };
};
if (wantUnits.length) {
  keys = keys.filter((cid) => {
    const { units } = pickGroup(cid);
    return units.some((u) => wantUnits.some((w) => u.includes(w)));
  });
}
if (ONLY) {
  const q = ONLY.toLowerCase();
  keys = keys.filter((cid) => pickGroup(cid).members.some((m) => m.term.toLowerCase().includes(q)));
}
keys.sort((a, b) => pickGroup(a).term.localeCompare(pickGroup(b).term));
if (Number.isFinite(LIMIT)) keys = keys.slice(SAMPLE_FROM, SAMPLE_FROM + LIMIT);

const corpus = loadCorpus();
console.log(`[corpus] sections=${corpus.length}  skills=${SKILLS_DIR}`);
console.log(`[plan] concept groups to process=${keys.length}`);

const records = [];
const stat = { groups: 0, graph: 0, ms: 0, tb: 0, theory: 0, needWeb: 0, defShort: 0, multiEntry: 0, singleWord: 0, looseOnly: 0, surnameOnly: 0, bothCross: 0, bothSame: 0, balancedCited: 0 };
const bothList = [];   // 「两侧都出现」的词条清单（相对题干的关系，用于验证 side 不能做词条级标签）

for (const cid of keys) {
  const { members, term, units } = pickGroup(cid);
  const repr = members.find((m) => m.relations && Object.keys(m.relations).length) ?? members[0];
  const chineses = [...new Set(members.map((m) => m.chinese).filter(Boolean))];
  const defs = [...new Set(members.map((m) => m.definition).filter(Boolean))].sort((a, b) => b.length - a.length);
  const definition = defs[0] ?? '';

  // 2) 图谱：聚合组内所有条目的关系边，解析为目标概念组的 term
  const g = { higher: new Set(), lower: new Set(), peer: new Set(), contrast: new Set() };
  for (const m of members) {
    for (const t of ['higher', 'lower', 'peer', 'contrast']) {
      for (const id of m.relations?.[t] ?? []) {
        const nm = termOfId(id);
        if (nm && nm.toLowerCase() !== term.toLowerCase()) g[t].add(nm);
      }
    }
  }
  const graph = {
    degree: g.higher.size + g.lower.size + g.peer.size + g.contrast.size,
    higher: [...g.higher].slice(0, 12),
    lower: [...g.lower].slice(0, 12),
    peer: [...g.peer].slice(0, 12),
    contrast: [...g.contrast].slice(0, 12),
  };

  // 词条自身的流派标签（学者走 theory，术语走 theories）
  const rawTags = [...new Set(members.flatMap((m) => [...(m.theories ?? []), m.theory ?? '']))].filter(Boolean);
  const theoryTags = rawTags.filter((t) => t.length <= 40);
  const dirtyTags = rawTags.filter((t) => t.length > 40);

  // 3/4) 语料命中
  const surnameForms = repr.type === 'scholar' ? scholarSurnames(term) : [];
  const matchers = makeMatchers(term, chineses, surnameForms);
  const ms = [];
  const tb = [];
  for (const sec of corpus) {
    for (const mt of matchers) {
      if (!mt.re.test(sec.text)) continue;
      const hit = { source: sec.source, heading: sec.heading, label: sec.label, match: mt.form, snippet: snippet(sec.text, mt.re) };
      if (sec.kind === 'ms') {
        hit.role = msRole(sec.heading, sec.label); // 相对本章主张的侧别（bullet 级，非绝对）
        hit.claim = sec.claim || '';               // 本章核心主张，用于解释侧别的参照系
        ms.push(hit);
      } else { hit.book = sec.kind; tb.push(hit); }
      break; // 一个小节只记一次
    }
  }

  // 5) 标记
  const flags = [];
  if (members.length > 1) { flags.push('multi-entry'); stat.multiEntry++; }
  if (!graph.degree) flags.push('no-graph');
  if (!ms.length) flags.push('no-ms-hit');
  if (!tb.length) flags.push('no-textbook-hit');
  if (!theoryTags.length) flags.push('no-theory-tag');
  if (definition.length < 40) { flags.push('def-short'); stat.defShort++; }
  if (dirtyTags.length) flags.push('theory-tag-dirty');
  if (isSingleWord(term)) { flags.push('single-word-term'); stat.singleWord++; }
  // 只被"核心短语"松散匹配命中 → 命中可信度打折，需人核
  if ([...ms, ...tb].length && [...ms, ...tb].every((h) => h.match === 'core')) {
    flags.push('loose-hit-only');
    stat.looseOnly++;
  }
  // 只被"姓氏"命中（正文照例只写姓；同名学者可能混淆，如 Young）→ 需人核
  if ([...ms, ...tb].length && [...ms, ...tb].every((h) => h.match === 'surname')) {
    flags.push('surname-only-hit');
    stat.surnameOnly++;
  }
  // 「正反」是相对题干的关系，不是词条的绝对属性。
  // 统计同一个词条在 ms 两侧都出现的情况：跨章出现 = 不同论题下的侧别翻转；同章出现 = 同一论题下的双面引用。
  const roles = new Set(ms.map((h) => h.role));
  const byFile = new Map();
  for (const h of ms) {
    if (!byFile.has(h.source)) byFile.set(h.source, new Set());
    byFile.get(h.source).add(h.role);
  }
  const bothCross = roles.has('support') && roles.has('oppose');
  const bothSame = [...byFile.values()].some((s) => s.has('support') && s.has('oppose'));
  if (bothCross) { flags.push('ms-both-sides'); stat.bothCross++; }
  if (bothSame) { flags.push('ms-both-sides-same-chapter'); stat.bothSame++; }
  if (roles.has('balanced')) { flags.push('ms-balanced-cited'); stat.balancedCited++; }
  if (bothCross) {
    bothList.push({
      term: `${term} [${repr.type}]`,
      sameChapter: bothSame,
      hits: ms.map((h) => `${h.role}(${h.label.slice(0, 10)})@${h.source.replace(/^ms:/, '')}`),
    });
  }
  if (!graph.degree && !ms.length && !tb.length) { flags.push('need-web'); stat.needWeb++; }

  if (graph.degree) stat.graph++;
  if (ms.length) stat.ms++;
  if (tb.length) stat.tb++;
  if (theoryTags.length) stat.theory++;
  stat.groups++;

  records.push({
    cid,
    type: repr.type,
    term,
    variants: [...new Set(members.map((m) => m.term))],
    entries: members.length,
    chinese: chineses,
    unit: units,
    paper: [...new Set(members.map((m) => m.paper).filter(Boolean))],
    definition,
    definitionAll: defs.length > 1 ? defs.slice(1) : undefined,
    graph,
    theoryTags,
    ms: compressMs(ms),
    textbook: tb.slice(0, 6),
    flags,
  });
}

// ---------- 输出 ----------
const outPath = args.out ? resolve(APP_DIR, args.out) : join(APP_DIR, 'scripts', 'out', `evidence-v${version}.jsonl`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

console.log(`\n[out] ${outPath}  records=${records.length}`);
console.log(`[coverage] graph=${stat.graph}  ms=${stat.ms}  textbook=${stat.tb}  theoryTag=${stat.theory}  |  need-web=${stat.needWeb}  def-short=${stat.defShort}  multi-entry=${stat.multiEntry}  single-word=${stat.singleWord}  loose-hit-only=${stat.looseOnly}  surname-only=${stat.surnameOnly}  (of ${stat.groups})`);

// 「正反」的相对性体检：侧别相对题干，不能作为词条属性
if (bothList.length) {
  const sameCh = bothList.filter((b) => b.sameChapter);
  const crossCh = bothList.filter((b) => !b.sameChapter);
  const short = (b) => b.hits.slice(0, 4).join(' , ');
  console.log(`\n[sides] 两侧都出现过: ${stat.bothCross} 个  |  同一章内双面("Willis 型"): ${stat.bothSame} 个  |  明确标注"平衡/两面"的 bullet: ${stat.balancedCited} 个`);
  console.log('  --- Willis 型 · 学者（同一引文在同一论述里两侧并用）---');
  for (const b of sameCh.filter((x) => x.term.includes('[scholar]')).slice(0, 10)) {
    console.log(`  - ${b.term}  ${short(b)}`);
  }
  console.log('  --- Willis 型 · 术语 ---');
  for (const b of sameCh.filter((x) => !x.term.includes('[scholar]')).slice(0, 10)) {
    console.log(`  - ${b.term}  ${short(b)}`);
  }
  console.log(`  --- 跨章翻转（择 6 / 共 ${crossCh.length}）---`);
  for (const b of crossCh.slice(0, 6)) console.log(`  - ${b.term}  ${short(b)}`);
  console.log('  提示：side 是 (词条 × 题干) 的函数，不是词条标签。');
}

// 侧别工作表：供 LLM/教师判定「题干 ↔ 该章核心主张是否同向」，再用 sideForHit() 推出侧别
if (args.worksheet) {
  console.log(`\n[worksheet] statement = "${args.worksheet}"`);
  console.log('  每条为 (该章内侧别, bullet 行首标记, 章文件) + 该章核心主张；');
  console.log('  判定"题干与该章主张是否同向"后，用 sideForHit(role, aligned) 推出该题下的侧别。');
  for (const r of records) {
    const hits = r.ms.filter((h) => h.claim && (h.role === 'support' || h.role === 'oppose'));
    if (!hits.length) continue;
    console.log(`\n  ▸ ${r.term} [${r.type}]  flags=${r.flags.join(',')}`);
    for (const h of hits) {
      console.log(`    ${h.role.padEnd(8)} ${h.label.slice(0, 18).padEnd(20)} @${h.source.replace(/^ms:/, '')}`);
      console.log(`        claim: ${h.claim.slice(0, 120)}`);
    }
  }
}

if (args.verbose) {
  for (const r of records) {
    console.log(`\n--- ${r.term}  [${r.type}]  entries=${r.entries} flags=${r.flags.join(',')}`);
    console.log(`    graph(${r.graph.degree}): hi=[${r.graph.higher.join('; ')}] lo=[${r.graph.lower.join('; ')}] peer=[${r.graph.peer.join('; ')}] contra=[${r.graph.contrast.join('; ')}]`);
    if (r.theoryTags.length) console.log(`    theoryTags: ${r.theoryTags.join(' | ')}`);
    for (const h of r.ms) console.log(`    ms[${h.role}] ${h.source} §${h.heading}: ${h.snippet.slice(0, 150)}`);
    for (const h of r.textbook.slice(0, 2)) console.log(`    ${h.book} §${h.heading}: ${h.snippet.slice(0, 130)}`);
  }
}
