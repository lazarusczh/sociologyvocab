import { readFileSync } from 'fs';
const items = JSON.parse(readFileSync('public/vocab-data.json', 'utf8'));

const targets = [
  'Conversion (of capitals)',
  'Cultural factor (deprivation)',
  'Editorial freedom / independence',
  'RIAS (Ageas), a British insurance company',
  '(Gloria Jean Watkins) bell hooks',
  'Ulrich Beck (& Elisabeth Beck-Gernsheim)',
  'Michael (Dunlop) Young',
  'Centre for the Modern Family (quoted by Daily Mail)',
];

for (const t of targets) {
  const found = items.filter((i) => i.term === t);
  for (const it of found) {
    console.log('TERM:', JSON.stringify(it.term));
    console.log('  type:', it.type, '| category:', it.category);
    console.log('  中文:', JSON.stringify(it.chinese));
    console.log('  定义:', JSON.stringify(it.definition));
    console.log('  theory:', JSON.stringify(it.theory || ''));
    console.log('');
  }
}