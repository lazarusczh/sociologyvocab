// 切题 md → 组卷器题库 question-bank.json
// 用法：node scripts/generate-question-bank.mjs
// 输入：项目根 5 份切题 md；输出：项目根 question-bank.json
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const OUT = join(ROOT, 'question-bank.json');

const MD_FILES = [
  { paper: 1, file: 'Paper1真题-按考点.md' },
  { paper: 2, file: 'Paper2真题-历年切题(至S26).md' },
  { paper: 3, file: 'Paper3真题-历年切题(至S26).md' },
  { paper: 4, file: 'Paper4Globalisation真题-历年切题(至S26).md' },
  { paper: 4, file: 'Paper4Media真题-历年切题(至S26).md' },
];

const META_HEAD = /附|附录|统计速览|已确认口径|待办|增补/;
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const OPEN_Q = new Set(['\u2018', '\u201c', "'", '"']);

function cleanTitle(t) {
  return t.replace(/\u2014\u2014独立\s*Topic\s*（[^）]*）/g, '').replace(/\u2014\u2014\s*独立\s*[^（]*$/, '');
}
function cleanHeading(t) {
  t = t.replace(/^\s*\d+(?:\.\d+)*\s*[.、]?\s*/, '');
  t = t.replace(/\s*\[\d+(?:\s*\+\s*\d+)?\](?:\s*\/\s*\[\d+(?:\s*\+\s*\d+)?\])*\s*$/, '');
  t = cleanTitle(t);
  return norm(t);
}
function stripNotes(body) {
  let marks = '';
  let text = body;
  const mm = text.match(/\[(\d+(?:\s*\+\s*\d+)?)\]/);
  if (mm) {
    marks = mm[1].replace(/\s+/g, '');
    text = (text.slice(0, mm.index) + text.slice(mm.index + mm[0].length)).trim();
  }
  const wi = text.indexOf('\u26a0');
  if (wi > -1) text = text.slice(0, wi).trim();
  const pm = text.match(/[（(][^（()）]{1,80}[）)]\s*$/);
  if (pm) text = text.slice(0, pm.index).trim();
  return { marks, text: norm(text) };
}
function splitStatement(body) {
  if (!body || !OPEN_Q.has(body[0])) return { statement: '', instruction: body };
  const inner = body.slice(1);
  const closeRe = /[\u2019\u201d'"]/g;
  let m;
  let closeAt = -1;
  while ((m = closeRe.exec(inner))) {
    const tail = inner.slice(m.index + 1).replace(/^[\s.,;:!?]+/, '');
    if (!tail || /^[A-Z（(]/.test(tail)) { closeAt = m.index; break; }
  }
  if (closeAt === -1) return { statement: norm(inner), instruction: '' };
  return {
    statement: norm(inner.slice(0, closeAt)),
    instruction: norm(inner.slice(closeAt + 1).replace(/^[\s.,;:!?]+/, '')),
  };
}
function parseSources(inner) {
  const out = [];
  for (const seg0 of inner.split(';')) {
    const seg = seg0.trim();
    if (/specimen/i.test(seg)) continue;
    const sm = seg.match(/[SMW]\d{2}/i);
    if (!sm) continue;
    const session = sm[0].toUpperCase();
    const tail = seg.slice(session.length);
    const comps = (tail.match(/\d{2}/g) || []).filter((d, i, a) => a.indexOf(d) === i);
    const qm = tail.match(/Q\s*(\d+)([abAB])?/);
    const q = qm ? qm[1] + (qm[2] ? qm[2].toLowerCase() : '') : null;
    for (const comp of comps) {
      if (/4$/.test(comp)) continue; // variant4 = 新老大纲交接期遗留老卷（如 S21 QP24），排除
      out.push({ session, comp, q });
    }
  }
  return out;
}
function parseQuestionRow(raw, paper, path) {
  const line = raw.trim().replace(/^[-*]\s+/, '');
  const m = line.match(/^\((.*?)\)\s*([\s\S]*)$/) || line.match(/^\[(.*?)\]\s*([\s\S]*)$/);
  if (!m) return [];
  const sources = parseSources(m[1]);
  if (!sources.length) return [];
  const { marks: marksRaw, text } = stripNotes(m[2]);
  if (!text) return [];
  const marks = paper === 4 && !marksRaw ? '35' : marksRaw;
  const marksTotal = (marks.match(/\d+/g) || []).reduce((a, b) => a + Number(b), 0);
  const { statement } = splitStatement(text);
  const kind = marks.includes('+') ? 'statement-pair' : statement ? 'statement' : 'plain';
  const parts = kind === 'statement-pair'
    ? marks.split('+').map((v, i) => ({ part: i === 0 ? 'a' : 'b', marks: Number(v.trim()), side: i === 0 ? 'for' : 'against' }))
    : undefined;
  return sources.map((s) => ({
    paper,
    source: { session: s.session, paper, variant: Number(s.comp) % 10, comp: s.comp, q: s.q },
    kind,
    stem: text,
    statement: kind === 'plain' ? null : statement,
    marks,
    topics: [...path],
    marksTotal,
    parts,
  }));
}
function qidFor(item) {
  const { session, comp, q } = item.source;
  if (q) return session + '_' + comp + '_q' + q;
  return session + '_' + comp + '_e' + md5(item.stem).slice(0, 8);
}

const items = new Map();
for (const f of MD_FILES) {
  const lines = readFileSync(join(ROOT, f.file), 'utf-8').split(/\r?\n/);
  const stack = [];
  for (const raw of lines) {
    const h = raw.match(/^(#{2,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
      const skip = (stack.length && stack[stack.length - 1].skip) || META_HEAD.test(h[2]);
      stack.push({ lvl, skip, title: cleanHeading(h[2]) });
      continue;
    }
    if (!/^\s*[-*]\s+/.test(raw)) continue;
    if (stack.some((n) => n.skip)) continue;
    const path = stack.map((n) => n.title).filter(Boolean);
    for (const cand of parseQuestionRow(raw, f.paper, path)) {
      const key = cand.paper + '|' + cand.source.session + '|' + cand.source.comp + '|' + (cand.source.q ?? '') + '|' + norm(cand.stem);
      const exist = items.get(key);
      if (exist) {
        for (const t of cand.topics) if (!exist.topics.includes(t)) exist.topics.push(t);
      } else {
        items.set(key, { qid: qidFor(cand), source: cand.source, stem: cand.stem, statement: cand.statement, marks: cand.marks, topics: cand.topics, marksTotal: cand.marksTotal, kind: cand.kind, parts: cand.parts });
      }
    }
  }
}
const stats = { paper: {}, kind: {}, marks: {} };
for (const it of items.values()) {
  stats.paper[it.source.paper] = (stats.paper[it.source.paper] || 0) + 1;
  stats.kind[it.kind] = (stats.kind[it.kind] || 0) + 1;
  stats.marks[it.marks] = (stats.marks[it.marks] || 0) + 1;
}
const bank = [...items.values()];
// 同 session+comp+题号 存在多条不同真实题干时（md 中少数槽位复用/跨考点重复），qid 追加 stem 哈希以保唯一
const usedQids = new Set();
for (const it of bank) {
  let qid = it.qid;
  if (usedQids.has(qid)) {
    let extra = 4;
    do { qid = it.qid + '_e' + md5(it.stem).slice(0, extra); extra += 4; } while (usedQids.has(qid));
  }
  usedQids.add(qid);
  it.qid = qid;
}
writeFileSync(OUT, JSON.stringify(bank, null, 1));
console.log('TOTAL', bank.length);
console.log('byPaper', JSON.stringify(stats.paper));
console.log('kinds', JSON.stringify(stats.kind));
console.log('marks', JSON.stringify(stats.marks));
console.log('written', OUT);
