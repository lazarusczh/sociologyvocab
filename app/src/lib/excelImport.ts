import * as XLSX from 'xlsx';
import type { VocabItem, ImportResult } from './types';
import { cleanText, uid } from './shuffle';

// 从文件名推断学者表的主题
function categoryFromFilename(filename: string): string {
  const base = filename.replace(/\.xlsx$/i, '').replace(/\s*name\s*sheet/i, '');
  // 去掉 "A1 " / "A2 " 等前缀
  return base.replace(/^A[12]\s+/i, '').trim() || '学者';
}

// 检测某行是否是"学者人名表"的表头行
function isNameSheetHeader(row: string[]): boolean {
  if (!row || row.length === 0) return false;
  const joined = row.map((c) => String(c).toLowerCase()).join('|');
  return joined.includes('theory') && joined.includes('name');
}

// 解析学者人名表（单 sheet）
function parseNameSheet(
  rows: string[][],
  category: string,
): { items: VocabItem[]; warnings: string[] } {
  const items: VocabItem[] = [];
  const warnings: string[] = [];
  let headerIdx = -1;
  let theoryCol = 0;
  let nameCol = 2;
  let descCol = 3;
  let notesCol = 4;

  // 找到表头行
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (isNameSheetHeader(rows[i])) {
      headerIdx = i;
      const lower = rows[i].map((c) => String(c).toLowerCase());
      const find = (kw: string) => lower.findIndex((c) => c.includes(kw));
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

  if (headerIdx === -1) {
    // 没找到表头，按默认列从第 2 行开始
    headerIdx = 1;
  }

  let lastTheory = '';
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const theory = cleanText(row[theoryCol] ?? '');
    const name = cleanText(row[nameCol] ?? '');
    const desc = cleanText(row[descCol] ?? '');
    const notes = cleanText(row[notesCol] ?? '');

    if (theory) lastTheory = theory;
    if (!name) continue; // 没有名字的行跳过

    items.push({
      id: uid('sch'),
      type: 'scholar',
      term: name,
      chinese: '',
      definition: desc || notes || lastTheory,
      category,
      theory: lastTheory,
      notes: notes || undefined,
    });
  }

  if (items.length === 0) {
    warnings.push(`学者表「${category}」未解析到数据`);
  }
  return { items, warnings };
}

// 解析术语表（多 sheet）
function parseTermSheet(
  rows: string[][],
  category: string,
): { items: VocabItem[]; warnings: string[] } {
  const items: VocabItem[] = [];
  const warnings: string[] = [];
  let startIdx = 0;

  // 跳过标题行（通常第 0 行是 "Part I: ..." 这类标题）
  // 若第 0 行第 0 列像标题（含中文或含 "Part"），从第 1 行开始
  if (rows[0] && rows[0][0]) {
    const first = String(rows[0][0]);
    if (/part\s/i.test(first) || /[\u4e00-\u9fa5]/.test(first)) {
      startIdx = 1;
    }
  }

  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i] || [];
    const english = cleanText(row[0] ?? '');
    const chinese = cleanText(row[1] ?? '');
    const definition = cleanText(row[2] ?? '');
    if (!english) continue;
    // 跳过看起来像表头的行
    if (/^(english|term|word)$/i.test(english)) continue;

    items.push({
      id: uid('term'),
      type: 'term',
      term: english,
      chinese,
      definition,
      category,
    });
  }

  if (items.length === 0) {
    warnings.push(`术语表「${category}」未解析到数据`);
  }
  return { items, warnings };
}

// 主入口：解析一个 Excel 文件（可能含多 sheet）
export async function parseExcelFile(file: File): Promise<ImportResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const items: VocabItem[] = [];
  const warnings: string[] = [];
  const filename = file.name;
  const isNameFile = /name\s*sheet/i.test(filename);

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    if (rows.length === 0) continue;

    // 判断该 sheet 是学者表还是术语表
    let useNameSheet = isNameFile;
    if (!useNameSheet) {
      // 多 sheet 文件里也可能混入学者表，用表头探测
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        if (isNameSheetHeader(rows[i] as string[])) {
          useNameSheet = true;
          break;
        }
      }
    }

    if (useNameSheet) {
      const category = isNameFile ? categoryFromFilename(filename) : sheetName;
      const res = parseNameSheet(rows as string[][], category);
      items.push(...res.items);
      warnings.push(...res.warnings);
    } else {
      const res = parseTermSheet(rows as string[][], sheetName);
      items.push(...res.items);
      warnings.push(...res.warnings);
    }
  }

  const termCount = items.filter((i) => i.type === 'term').length;
  const scholarCount = items.filter((i) => i.type === 'scholar').length;
  const categories = [...new Set(items.map((i) => i.category))].sort();

  return { items, termCount, scholarCount, categories, warnings };
}

// 批量解析多个文件
export async function parseExcelFiles(files: File[]): Promise<ImportResult> {
  const allItems: VocabItem[] = [];
  const allWarnings: string[] = [];
  for (const file of files) {
    try {
      const res = await parseExcelFile(file);
      allItems.push(...res.items);
      allWarnings.push(...res.warnings);
    } catch (e) {
      allWarnings.push(`读取「${file.name}」失败：${(e as Error).message}`);
    }
  }
  const termCount = allItems.filter((i) => i.type === 'term').length;
  const scholarCount = allItems.filter((i) => i.type === 'scholar').length;
  const categories = [...new Set(allItems.map((i) => i.category))].sort();
  return { items: allItems, termCount, scholarCount, categories, warnings: allWarnings };
}
