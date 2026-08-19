import { readFileSync } from 'fs';
const items = JSON.parse(readFileSync('public/vocab-data.json', 'utf8'));

const names = [
  'America Sociology Association (ASA)',
  'America Psychology Association (APA)',
  'Glasgow University Media Group (GUMG)',
  'Anti-Globalisation Movement (AGM)',
];

for (const n of names) {
  for (const it of items.filter((i) => i.term === n)) {
    console.log(JSON.stringify(n), '=> type:', it.type, '| category:', it.category, '| theory:', it.theory || '');
  }
}

// 也统计含括号的 term 类型总览
console.log('\n--- 所有含括号/斜杠的 term 类型条目 ---');
for (const it of items) {
  if (it.type === 'term' && (it.term.includes('(') || it.term.includes('/'))) {
    console.log(`[${it.category}] ${JSON.stringify(it.term)}`);
  }
}
console.log('\n--- 所有含括号/斜杠的 scholar 类型条目 ---');
for (const it of items) {
  if (it.type === 'scholar' && (it.term.includes('(') || it.term.includes('/'))) {
    console.log(`[${it.category}] ${JSON.stringify(it.term)}`);
  }
}