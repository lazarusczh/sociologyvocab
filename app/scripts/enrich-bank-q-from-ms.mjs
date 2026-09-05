// 用 ms-data.json 给题库无题号行（P2/P3 source.q=null）按题干反查 ms 分节补题号
// 用法：node scripts/enrich-bank-q-from-ms.mjs   （直接更新根目录 question-bank.json）
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const bank = JSON.parse(readFileSync(join(ROOT, 'question-bank.json'), 'utf8'));
const msData = JSON.parse(readFileSync(join(ROOT, 'ms-data.json'), 'utf8'));
const msMap = new Map(msData.map((m) => [m.session + '_' + m.comp, m.sections]));

const norm = (s) => (s || '').toLowerCase()
  .replace(/[\u2018\u2019\u201c\u201d'"\u00b4`]/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ');
const compact = (s) => norm(s).replace(/ /g, '');
const tokens = (s) => norm(s).split(' ').filter(Boolean);

function match(stem, sections) {
  const cStem = compact(stem);
  let best = { score: 0, q: null };
  for (const sec of sections) {
    const cSec = compact(sec.text);
    if (cStem && cSec.includes(cStem)) return { score: 1, q: sec.q };
    const st = tokens(stem);
    const stSet = new Set(st);
    const hit = st.filter((w) => cSec.includes(w)).length;
    const score = st.length ? hit / st.length : 0;
    if (score > best.score) best = { score, q: sec.q };
  }
  return best;
}

const matched = [];
const unmatched = [];
for (const it of bank) {
  if (it.source.q != null) continue;
  const key = it.source.session.toLowerCase() + '_' + it.source.comp;
  const sections = msMap.get(key) || [];
  const res = match(it.stem, sections);
  if (res.q) matched.push({ it, q: res.q, score: res.score });
  else unmatched.push(it);
}

console.log('q-null rows:', matched.length + unmatched.length, ' matched:', matched.length, ' unmatched:', unmatched.length);
console.log('unmatched samples:', unmatched.slice(0, 15).map((x) => `${x.source.session}_${x.source.comp} | ${(x.stem || '').slice(0, 45)}`));
console.log('matched score<1 (fallback fuzzy):', matched.filter((m) => m.score < 1).length);
console.log('matched q dist:', JSON.stringify(Object.entries(matched.reduce((a, m) => ((a[m.q] = (a[m.q] || 0) + 1), a), {})).sort((x, y) => y[1] - x[1])));
const byPaper = matched.reduce((a, m) => ((a[m.it.source.paper] = (a[m.it.source.paper] || 0) + 1), a), {});
console.log('matched by paper:', JSON.stringify(byPaper));

// 应用：q 取基础题号（去掉 (a)/(b)）；重算 qid 并唯一化
const qidBase = (it) => {
  const { session, comp, q } = it.source;
  return q ? `${session}_${comp}_q${q}` : `${session}_${comp}_e${createHash('md5').update(it.stem).digest('hex').slice(0, 8)}`;
};
for (const { it, q } of matched) {
  it.source.q = q.replace(/\(\w\)/g, '');
}
const used = new Set();
for (const it of bank) {
  let qid = qidBase(it);
  if (used.has(qid)) {
    let extra = 4;
    do { qid = qidBase(it) + '_e' + createHash('md5').update(it.stem).digest('hex').slice(0, extra); extra += 4; } while (used.has(qid));
  }
  used.add(qid);
  it.qid = qid;
}
writeFileSync(join(ROOT, 'question-bank.json'), JSON.stringify(bank, null, 1));
console.log('updated question-bank.json rows=', bank.length, ' qid changed rows=', matched.length);
