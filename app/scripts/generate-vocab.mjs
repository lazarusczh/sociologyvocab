// 一次性脚本：将 Excel 词库转换为内置词库 JSON
import XLSX from 'xlsx';
import { readFileSync, writeFileSync } from 'fs';

const XLSXlib = XLSX;

// 单元映射：原始主题 → 类型 → 术语 → 单元名数组（unit-mapping.json 是唯一 source of truth，直接维护）
const UNIT_MAPPING = JSON.parse(readFileSync('./src/lib/unit-mapping.json', 'utf8'));
function unitsFor(category, type, term) {
  return UNIT_MAPPING[category]?.[type]?.[term] ?? [];
}

// 可接受答案别名（answer-aliases.json 是 source of truth，直接烘焙进词条）
const ALIASES = JSON.parse(readFileSync('./src/lib/answer-aliases.json', 'utf8'));
function aliasesFor(type, term) {
  const table = type === 'term' ? ALIASES.termAliases : ALIASES.scholarAliases;
  return table?.[term] ?? null;
}

const FILES = [
  '../Sociology Vocabulary (A-Z order with definitions).xlsx', // 术语表（多 sheet）
  '../A1 Family Name sheet.xlsx',
  '../A1 Socialisation Methodology Identity Name sheet.xlsx',
  '../A2 Education Name sheet.xlsx',
  '../A2 Globalisation Name Sheet.xlsx',
  '../A2 Media Name sheet.xlsx',
];

function clean(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 确定性 id：与 app/src/lib/shuffle.ts 的 stableId 保持一致
function stableId(type, term, paper, category, units) {
  const unitKey = units && units.length ? units.slice().sort().join(',') : '';
  const key = [type, term.trim().toLowerCase(), paper, category, unitKey].join('||');
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = (Math.imul(h1, 33) + c) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return `${type === 'scholar' ? 'sch' : 'term'}_${h1.toString(36)}${h2.toString(36)}`;
}

function isNameHeader(row) {
  if (!row || !row.length) return false;
  const j = row.map((c) => String(c).toLowerCase()).join('|');
  return j.includes('theory') && j.includes('name');
}

function categoryFromFilename(f) {
  const base = f
    .replace(/\.xlsx$/i, '')
    .replace(/\s*name\s*sheet/i, '')
    .replace(/\.[^/\\]*$/, '');
  // 取路径最后一段
  const name = base.split(/[\\/]/).pop();
  return name.replace(/^A[12]\s+/i, '').trim() || '学者';
}

// 旧「主题」→ { 考卷 Paper, 次级标签 sub } 的映射（与 app/src/lib/excelImport.ts 保持一致）
const CATEGORY_TO_PAPER = {
  'Social theories & socialisation': { paper: 'Paper 1', sub: '' },
  'Research methods': { paper: 'Paper 1', sub: '' },
  'Social identities': { paper: 'Paper 1', sub: '' },
  'Socialisation Methodology Identity': { paper: 'Paper 1', sub: '' },
  'Family': { paper: 'Paper 2', sub: 'Family' },
  'Education': { paper: 'Paper 3', sub: 'Education' },
  'Globalisation': { paper: 'Paper 4', sub: 'Globalisation' },
  'Media': { paper: 'Paper 4', sub: 'Media' },
};

function paperInfo(category) {
  return CATEGORY_TO_PAPER[category] || { paper: 'Paper 1', sub: category };
}

const items = [];
let termCount = 0;
let schCount = 0;

for (const file of FILES) {
  const wb = XLSXlib.readFile(file);
  const isNameFile = /name\s*sheet/i.test(file);

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSXlib.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows.length) continue;

    let useNameSheet = isNameFile;
    if (!useNameSheet) {
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        if (isNameHeader(rows[i])) { useNameSheet = true; break; }
      }
    }

    if (useNameSheet) {
      // 学者表
      const category = isNameFile ? categoryFromFilename(file) : sheetName;
      const { paper, sub } = paperInfo(category);
      let headerIdx = -1;
      let theoryCol = 0, nameCol = 2, descCol = 3, notesCol = 4;
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        if (isNameHeader(rows[i])) {
          headerIdx = i;
          const lower = rows[i].map((c) => String(c).toLowerCase());
          const find = (kw) => lower.findIndex((c) => c.includes(kw));
          const t = find('theory') !== -1 ? find('theory') : find('ideology');
          if (t !== -1) theoryCol = t;
          const n = find('name');
          if (n !== -1) nameCol = n;
          const d = find('theory and stat') !== -1 ? find('theory and stat') : find('theory/stat');
          if (d !== -1) descCol = d;
          const nt = find('note');
          if (nt !== -1) notesCol = nt;
          break;
        }
      }
      if (headerIdx === -1) headerIdx = 1;

      let lastTheory = '';
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const theory = clean(row[theoryCol]);
        const name = clean(row[nameCol]);
        const desc = clean(row[descCol]);
        const notes = clean(row[notesCol]);
        if (theory) lastTheory = theory;
        if (!name) continue;
        items.push({
          id: stableId('scholar', name, paper, sub, unitsFor(category, 'scholar', name)),
          type: 'scholar',
          term: name,
          chinese: '',
          definition: desc || notes || lastTheory,
          paper,
          category: sub,
          unit: unitsFor(category, 'scholar', name),
          aliases: aliasesFor('scholar', name) || undefined,
          theory: lastTheory,
          notes: notes || undefined,
        });
        schCount++;
      }
    } else {
      // 术语表
      const category = sheetName;
      const { paper, sub } = paperInfo(category);
      let startIdx = 0;
      if (rows[0] && rows[0][0]) {
        const first = String(rows[0][0]);
        if (/part\s/i.test(first) || /[\u4e00-\u9fa5]/.test(first)) startIdx = 1;
      }
      for (let i = startIdx; i < rows.length; i++) {
        const row = rows[i] || [];
        const english = clean(row[0]);
        const chinese = clean(row[1]);
        const definition = clean(row[2]);
        if (!english) continue;
        if (/^(english|term|word)$/i.test(english)) continue;
        items.push({
          id: stableId('term', english, paper, sub, unitsFor(category, 'term', english)),
          type: 'term',
          term: english,
          chinese,
          definition,
          paper,
          category: sub,
          unit: unitsFor(category, 'term', english),
          aliases: aliasesFor('term', english) || undefined,
        });
        termCount++;
      }
    }
  }
}

writeFileSync(
  '../app/public/vocab-data.json',
  JSON.stringify(items),
  'utf8',
);

console.log(`总计 ${items.length} 条（术语 ${termCount}，学者 ${schCount}）`);
console.log('主题:', [...new Set(items.map((i) => i.category))].sort().join('、'));