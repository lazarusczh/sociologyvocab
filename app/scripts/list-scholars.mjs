import { readFileSync } from 'fs';
const items = JSON.parse(readFileSync('public/vocab-data.json', 'utf8'));

const scholars = items.filter((i) => i.type === 'scholar');
console.log('总学者/机构条目:', scholars.length);

const byTheory = {};
for (const s of scholars) {
  const t = s.theory || '(无理论流派)';
  (byTheory[t] = byTheory[t] || []).push(s.term);
}

for (const [theory, terms] of Object.entries(byTheory)) {
  console.log(`\n【${theory}】 (${terms.length})`);
  for (const t of terms) console.log('  -', JSON.stringify(t));
}