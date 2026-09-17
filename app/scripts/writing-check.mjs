// 写作练习素材校验器（PEEL 范段落）
//
// 定位：**既是生成器的质检，也是位置标签的体检**（见 写作练习方案.md 第六节）。
// 现在先拿已有的 16 段人工范段落当正样本校准它；等生成器落地后，它就是生成器的出闸门。
//
// 用法：
//   node scripts/writing-check.mjs --md all                     # 扫描项目根下全部 PEEL范段落-*.md
//   node scripts/writing-check.mjs --md <file> --dump out.json  # 顺便导出规范化 JSON（生成器输出格式）
//   node scripts/writing-check.mjs --json out.json              # 校验规范化 JSON
//   node scripts/writing-check.mjs --selftest                   # 自检：故意注入 6 类缺陷，确认都能被抓到
//
// 检查项（E=错误 / W=警告）：
//   C1 结构完整   题干、侧别、4 句、字母 A–D 齐全、答案键 4 位
//   C2 动作完整   按答案键还原的动作序列必须是 P → E → Explain → Link
//   C3 词条在库   「用到的词条」必须都能在词库中找到（防错拼 / 防捏造）
//   C4 词条在正文 每条声明用到的词条必须真的出现在该段正文里（词形宽松）
//   C5 依据存在   必须有 ms / 教材依据（防凭空生成）
//   C6 Link 回题  正确顺序的末句须与题干共享实词（AO2「回到问题」的可机器化部分）
//   C7 难度阈值   句数、单句词数上限（可配）
//   C8 位置-标签  需要位置标签表；未建时跳过并标注（见 §5）
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const ROOT_DIR = resolve(APP_DIR, '..');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--selftest') args.selftest = true;
  else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
}
const LIMITS = { sentences: 4, maxWordsPerSentence: 45 };

// ---------- 词库（云端 v93 取证包）----------
function loadLexicon() {
  const p = join(APP_DIR, 'scripts', 'out', 'ev-all.jsonl');
  if (!existsSync(p)) {
    console.log('[warn] 未找到 ' + p + '（先跑 writing-label-evidence.mjs --all）');
    return { terms: new Set(), scholars: new Set(), labels: new Map() };
  }
  const terms = new Set();
  const scholars = new Set();
  const labels = new Map();
  for (const line of readFileSync(p, 'utf8').trim().split('\n')) {
    const r = JSON.parse(line);
    terms.add(r.term.toLowerCase());
    if (r.type === 'scholar') scholars.add(r.term.toLowerCase());
    labels.set(r.term.toLowerCase(), r);
  }
  console.log('[lexicon] 概念组 ' + terms.size + ' 条（含学者 ' + scholars.size + '）');
  return { terms, scholars, labels };
}

// ---------- 复用前端学者姓氏提取 ----------
const tmp = mkdtempSync(join(tmpdir(), 'wchk-'));
const bundle = join(tmp, 'answers.mjs');
execSync(`npx esbuild src/lib/answers.ts --bundle --format=esm --outfile=${bundle} --log-level=error`,
  { stdio: 'inherit', cwd: APP_DIR });
const { scholarSurnames } = await import(pathToFileURL(bundle).href);

// ---------- 词形宽松匹配 ----------
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'as', 'is', 'are',
  'that', 'this', 'it', 'be', 'been', 'by', 'with', 'from', 'not', 'their', 'its', 'they', 'we',
  'more', 'than', 'but', 'so', 'because', 'when', 'which', 'who', 'has', 'have', 'had', 'was', 'were']);

const words = (s) => (s || '').toLowerCase().match(/[a-z0-9]+/g) ?? [];

// 单词是否作为正文某个词的词头出现：容忍复数与派生（stereotype→stereotypes、marxism→Marxists、patriarchy→patriarchal）
function wordAppears(w, t) {
  if (!t) return false;
  if (t === w || t.startsWith(w)) return true;
  const core = w.length >= 8 ? w.slice(0, w.length - 3) : (w.length >= 6 ? w.slice(0, w.length - 1) : w);
  return core.length >= 4 && t.startsWith(core);
}

// 词库用 "/" 表示同义写法（如 `'New Man' / 'New Father'`）→ 任一写法命中即可
function termAppears(term, text, textWords, lex) {
  const alts = term.split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  return alts.some((alt) => termAppearsOne(alt, text, textWords, lex));
}

// 单项写法是否出现在正文：多词按顺序前缀匹配；学者用姓氏（复用前端 scholarSurnames）
function termAppearsOne(term, text, textWords, lex) {
  const low = text.toLowerCase();
  if (low.includes(term.toLowerCase())) return true;
  const isScholar = lex.scholars.has(term.toLowerCase());
  const forms = isScholar
    ? scholarSurnames(term).filter((s) => /^[a-z][a-z'-]{2,}$/i.test(s)).map((s) => [s.toLowerCase()])
    : [words(term)];
  for (const f of forms) {
    if (!f.length) continue;
    let idx = 0;
    let ok = true;
    for (const w of f) {
      let found = -1;
      for (let i = idx; i < textWords.length; i++) {
        if (wordAppears(w, textWords[i])) { found = i; break; }
      }
      if (found < 0) { ok = false; break; }
      idx = found + 1;
    }
    if (ok) return true;
  }
  return false;
}

// ---------- md → 段落模型 ----------
const ORDER_RE = /顺序：\s*([A-Z](?:\s*→\s*[A-Z]){3})/;
const MOVE_NORM = { P: 'P', E: 'E', 'E·Explain': 'X', X: 'X', L: 'L' };

function parseMd(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const stu = new Map();     // n -> {title, statement, letters}
  const ans = new Map();     // n -> {order, moves, uses, evidence}
  let part = 1;
  let cur = null;
  for (const ln of lines) {
    if (/^#\s*第二部分/.test(ln)) { part = 2; cur = null; continue; }
    if (/^#\s*第/.test(ln)) cur = null;
    const h = ln.match(/^##\s*练习\s*(\d+)/);
    if (h) {
      cur = +h[1];
      if (part === 1) stu.set(cur, { title: ln.replace(/^##\s*练习\s*\d+[：:]?\s*/, '').trim(), statement: '', letters: {} });
      else if (!ans.has(cur)) ans.set(cur, { order: null, moves: {}, uses: [], evidence: '' });
      const m0 = ln.match(ORDER_RE);
      if (part === 2 && m0 && !ans.get(cur).order) ans.get(cur).order = m0[1].split('→').map((s) => s.trim());
      continue;
    }
    if (!cur) continue;
    if (part === 1) {
      const s = stu.get(cur);
      const ms = ln.match(/^\*\*题干\*\*[：:]\s*(.+)$/);
      if (ms) { s.statement = ms[1].replace(/（.*?）\s*/, '').replace(/\*\*/g, '').trim(); continue; }
      const ml = ln.match(/^\*\*([A-D])\.\*\*\s+(.*)$/);
      if (ml) { s.letters[ml[1]] = ml[2].trim(); continue; }
      const ma = ln.match(/^\*\*答案[：:]\s*(.+)\*\*$/);
      if (ma) { s.answerBlank = ma[1]; continue; }
    } else {
      const a = ans.get(cur);
      const mt = ln.match(/^\|\s*([A-D])\s*\|\s*\*\*([^*]+)\*\*([^|]*)\|/);
      if (mt) {
        // 两种写法都吃：`**E·Explain**`（动作在加粗内）与 `**E** Explain`（动作在加粗外）
        const raw = mt[2].trim();
        const tail = (mt[3] ?? '').trim();
        let mv;
        if (/explain/i.test(raw) || /explain/i.test(tail)) mv = 'X';
        else if (/^P/i.test(raw)) mv = 'P';
        else if (/^E/i.test(raw)) mv = 'E';
        else if (/^L/i.test(raw)) mv = 'L';
        else if (/^X/i.test(raw)) mv = 'X';
        else mv = MOVE_NORM[raw] ?? raw;
        a.moves[mt[1]] = mv;
        continue;
      }
      const m3 = ln.match(ORDER_RE);
      if (m3 && !a.order) { a.order = m3[1].split('→').map((s) => s.trim()); continue; }
      const mu = ln.match(/^\*\*用到的词条\*\*[^：:]*[：:]\s*(.+)$/);
      if (mu) {
        a.uses = [...mu[1].matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
        continue;
      }
      const me = ln.match(/^\*\*ms 依据\*\*[：:]\s*(.+)$/);
      if (me) { a.evidence = me[1].trim(); continue; }
    }
  }
  // 合并
  const out = [];
  for (const n of [...stu.keys()].sort((x, y) => x - y)) {
    const s = stu.get(n);
    const a = ans.get(n) ?? { order: null, moves: {}, uses: [], evidence: '' };
    const order = a.order ?? [];
    const sentences = order.map((L) => ({ letter: L, move: a.moves[L] ?? '?', text: s.letters[L] ?? '' }));
    out.push({
      id: basename(path).replace(/\.md$/, '') + '-' + String(n).padStart(2, '0'),
      n,
      title: s.title,
      statement: s.statement,
      stance: /反方/.test(s.title) ? 'against' : 'for',
      order,
      sentences,
      uses: a.uses,
      evidence: a.evidence,
      letters: s.letters,
      rawAnswers: a.moves,
    });
  }
  return out;
}

// ---------- 校验 ----------
function check(paras, lex) {
  const issues = [];
  const add = (sev, para, code, msg) => issues.push({ sev, para: para.id, code, msg });

  for (const p of paras) {
    // C1 结构
    if (!p.statement) add('E', p, 'C1-statement', '缺题干');
    if (!p.order || p.order.length !== 4) add('E', p, 'C1-order', '答案键不是 4 位');
    const letters = Object.keys(p.letters);
    if (letters.length !== 4) add('E', p, 'C1-letters', '句子字母数=' + letters.length + '（应 4）');
    // C2 动作完整
    const moves = p.sentences.map((s) => s.move);
    if (moves.length === 4 && moves.join(',') !== 'P,E,X,L') {
      add('E', p, 'C2-moves', '动作序列=' + moves.join('→') + '（应 P→E→Explain→Link）');
    }
    // C2b 答案键自洽：句子带话语标记时，可由标记反推顺序并与答案键比对
    const marked = Object.values(p.letters).filter((t) => /^(For example|This matters|This suggests|Together these|Therefore)/.test(t)).length;
    if (marked >= 2 && p.order.length === 4) {
      const by = {};
      for (const L of Object.keys(p.letters)) {
        const t = p.letters[L];
        if (/^For example/.test(t)) by.E = L;
        else if (/^(This matters|This suggests|Together these)/.test(t)) by.X = L;
        else if (/^(Therefore|This (evidence )?(supports|weakens))/.test(t)) by.L = L;
        else if (!by.P) by.P = L;
      }
      const derived = [by.P, by.E, by.X, by.L];
      if (derived.every(Boolean) && derived.join(',') !== p.order.join(',')) {
        add('E', p, 'C2-order', '答案键 ' + p.order.join('-') + ' 与话语标记反推 ' + derived.join('-') + ' 不一致');
      }
    }
    // C3/C4 词条
    const text = p.sentences.map((s) => s.text).join(' ');
    const tw = words(text);
    for (const t of p.uses) {
      const key = t.toLowerCase();
      if (!lex.terms.has(key)) add('E', p, 'C3-lexicon', '词条不在库：' + t);
      if (!termAppears(t, text, tw, lex)) add('E', p, 'C4-in-text', '词条声明使用了但正文没出现：' + t);
    }
    // C5 依据
    if (!p.evidence) add('W', p, 'C5-evidence', '缺 ms/教材依据');
    // C6 Link 回题
    if (p.statement && p.sentences.length === 4) {
      const stmtWords = new Set(words(p.statement).filter((w) => w.length >= 5 && !STOP.has(w)));
      const linkWords = new Set(words(p.sentences[3].text));
      const shared = [...stmtWords].filter((w) => linkWords.has(w) || [...linkWords].some((x) => x.startsWith(w.slice(0, 6))));
      if (!shared.length) add('W', p, 'C6-link', '末句与题干无共同实词（Link 可能没回到问题）');
    }
    // C7 难度
    if (p.sentences.length !== LIMITS.sentences) add('W', p, 'C7-count', '句数=' + p.sentences.length);
    for (const s of p.sentences) {
      const n = words(s.text).length;
      if (n > LIMITS.maxWordsPerSentence) add('W', p, 'C7-length', s.letter + ' 句词数=' + n + '（上限 ' + LIMITS.maxWordsPerSentence + '）');
    }
    // C8 位置-标签一致性（需要标签表）
    const labelsPath = join(APP_DIR, 'scripts', 'out', 'writing-labels.json');
    if (existsSync(labelsPath)) {
      const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
      for (const s of p.sentences) {
        for (const u of p.uses) {
          const role = labels[u];
          if (!role) continue;
          if (s.move === 'E' && role === 'explain') {
            add('E', p, 'C8-position', 'Evidence 句出现 explain 类词：' + u);
          }
        }
      }
    }
  }
  return issues;
}

// ---------- 报告 ----------
function report(name, paras, issues) {
  const E = issues.filter((i) => i.sev === 'E');
  const W = issues.filter((i) => i.sev === 'W');
  console.log('\n=== ' + name + ' === 段落=' + paras.length + '  错误=' + E.length + '  警告=' + W.length);
  for (const i of E) console.log('  [E] ' + i.para + ' ' + i.code + ' — ' + i.msg);
  for (const i of W) console.log('  [W] ' + i.para + ' ' + i.code + ' — ' + i.msg);
  if (!E.length && !W.length) console.log('  ✓ 全部通过');
  return E.length;
}

// ---------- 主流程 ----------
const lex = loadLexicon();
let failed = 0;

if (args.selftest) {
  const src = parseMd(join(ROOT_DIR, 'PEEL范段落-第二批-Paper1.md'));
  const base = check(src, lex);
  console.log('\n[selftest] 基线（应为 0 错误）: ' + base.filter((i) => i.sev === 'E').length);
  const mutations = [
    ['C1-statement', (p) => { p[0].statement = ''; }],
    // 用一个「在库但正文没有」的词条 → 只应触发 C4
    ['C4-in-text', (p) => { p[0].uses = [...p[0].uses, 'Cultural capital']; }],
    ['C3-lexicon', (p) => { p[0].uses = [...p[0].uses, 'Zzz Not A Term']; }],
    ['C2-moves', (p) => { p[0].sentences = [p[0].sentences[0], p[0].sentences[2], p[0].sentences[1], p[0].sentences[3]]; }],
    ['C2-order', (p) => { p[0].order = [p[0].order[1], p[0].order[0], p[0].order[2], p[0].order[3]]; }],
    ['C7-count', (p) => { p[0].sentences = p[0].sentences.slice(0, 3); }],
    ['C6-link', (p) => { p[0].sentences[3] = { ...p[0].sentences[3], text: 'Therefore, this view supports the statement.' }; }],
  ];
  let ok = 0;
  for (const [want, mutate] of mutations) {
    const copy = JSON.parse(JSON.stringify(src));
    mutate(copy);
    // 警告级（C6/C7）也要算检出
    const got = check(copy, lex).map((i) => i.code);
    const hit = got.some((c) => c.startsWith(want));
    console.log('  ' + (hit ? 'PASS' : 'FAIL') + '  注入 ' + want + ' → 检出 [' + got.join(',') + ']');
    if (hit) ok++;
  }
  console.log('[selftest] ' + ok + '/' + mutations.length + ' 通过');
  failed = ok === mutations.length ? 0 : 1;
} else {
  let paras = [];
  let name = '';
  if (args.json) {
    const j = JSON.parse(readFileSync(resolve(ROOT_DIR, args.json), 'utf8'));
    paras = j.paragraphs;
    name = basename(args.json);
  } else {
    const md = args.md ?? 'all';
    const files = md === 'all'
      ? readdirSync(ROOT_DIR).filter((f) => f.startsWith('PEEL') && f.endsWith('.md')).sort()
      : [basename(md)];
    for (const f of files) {
      const p = parseMd(join(ROOT_DIR, f));
      const issues = check(p, lex);
      failed += report(f, p, issues);
      paras.push(...p);
    }
  }
  if (args.json) failed += report(name, paras, check(paras, lex));

  if (args.dump) {
    const out = resolve(APP_DIR, args.dump);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      note: '由 writing-check.mjs --dump 从 md 规范化导出；即为生成器的目标输出格式',
      paragraphs: paras,
    }, null, 2), 'utf8');
    console.log('\n[dump] ' + out + '  段落=' + paras.length);
  }
}
process.exit(failed ? 1 : 0);
