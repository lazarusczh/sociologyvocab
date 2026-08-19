import { readFileSync } from 'fs';
const items = JSON.parse(readFileSync('public/vocab-data.json', 'utf8'));

// 找出包含括号、斜杠、连字符等可能暗示"同义多种写法"的术语
const paren = items.filter((i) => i.term.includes('(') || i.term.includes(')'));
const slash = items.filter((i) => i.term.includes('/'));

console.log('=== 含括号的术语 (', paren.length, ') ===');
for (const i of paren) {
  console.log(`[${i.category}] ${JSON.stringify(i.term)}`);
}

console.log('\n=== 含斜杠的术语 (', slash.length, ') ===');
for (const i of slash) {
  console.log(`[${i.category}] ${JSON.stringify(i.term)}`);
}