// 一次性脚本：将 Excel 词库转换为内置词库 JSON
import XLSX from 'xlsx';
import { writeFileSync } from 'fs';

const XLSXlib = XLSX;

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
          id: `sch_${schCount++}`,
          type: 'scholar',
          term: name,
          chinese: '',
          definition: desc || notes || lastTheory,
          paper,
          category: sub,
          theory: lastTheory,
          notes: notes || undefined,
        });
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
          id: `term_${termCount++}`,
          type: 'term',
          term: english,
          chinese,
          definition,
          paper,
          category: sub,
        });
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