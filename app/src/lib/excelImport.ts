import * as XLSX from 'xlsx';
import type { VocabItem, ImportResult } from './types';
import { cleanText, stableId } from './shuffle';
import { isSuspiciousScholarName, attachAliases } from './answers';
import { unitsForRaw, attachUnits } from './unitMapping';

// 旧「主题」→ { 考卷 Paper, 次级标签 sub } 的映射（对应 9699A Level 社会学大纲四张考卷）
// Paper 1 完全合并为一级，sub 为空；Paper 4 含 Globalisation / Media 两个次级标签
const CATEGORY_TO_PAPER: Record<string, { paper: string; sub: string }> = {
  'Social theories & socialisation': { paper: 'Paper 1', sub: '' },
  'Research methods': { paper: 'Paper 1', sub: '' },
  'Social identities': { paper: 'Paper 1', sub: '' },
  'Socialisation Methodology Identity': { paper: 'Paper 1', sub: '' },
  'Family': { paper: 'Paper 2', sub: 'Family' },
  'Education': { paper: 'Paper 3', sub: 'Education' },
  'Globalisation': { paper: 'Paper 4', sub: 'Globalisation' },
  'Media': { paper: 'Paper 4', sub: 'Media' },
};

// 由旧主题名推断考卷与次级标签（未知主题默认归入 Paper 1，次级标签保留原名）
export function paperInfo(category: string): { paper: string; sub: string } {
  return CATEGORY_TO_PAPER[category] ?? { paper: 'Paper 1', sub: category };
}

// 迁移旧词库数据：补齐 paper 字段，并把三级主题收敛为次级标签，同时补上 unit
export function migrateVocabItems(items: VocabItem[]): VocabItem[] {
  // Paper 2/3 各自只有一个次级标签，历史脏数据中可能出现 category 为空的情况，按 paper 补正
  const PAPER_DEFAULT_CAT: Record<string, string> = {
    'Paper 2': 'Family',
    'Paper 3': 'Education',
  };
  const migrated = items.map((i) => {
    if (i.paper) {
      if (!i.category && PAPER_DEFAULT_CAT[i.paper]) {
        return { ...i, category: PAPER_DEFAULT_CAT[i.paper] };
      }
      return i;
    }
    // 旧格式：原始 category 尚在，用它精确查 unit（避免 Paper 1 的 Cultural deprivation 冲突）
    const { paper, sub } = paperInfo(i.category);
    const units = unitsForRaw(i.category, i.type, i.term);
    return { ...i, paper, category: sub, ...(units.length ? { unit: units } : {}) };
  });
  // 已迁移但缺 unit 的旧数据（本地 localStorage）按 paper+sub 兜底补
  return attachAliases(attachUnits(migrated));
}

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
  source: string,
): { items: VocabItem[]; warnings: string[]; suspicious: string[] } {
  const items: VocabItem[] = [];
  const warnings: string[] = [];
  const suspicious: string[] = [];
  const { paper, sub } = paperInfo(source);
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

    if (isSuspiciousScholarName(name)) suspicious.push(name);

    items.push({
      id: stableId('scholar', name, paper, sub, unitsForRaw(source, 'scholar', name)),
      type: 'scholar',
      term: name,
      chinese: '',
      definition: desc || notes || lastTheory,
      paper,
      category: sub,
      unit: unitsForRaw(source, 'scholar', name),
      theory: lastTheory,
      notes: notes || undefined,
    });
  }

  if (items.length === 0) {
    warnings.push(`学者表「${source}」未解析到数据`);
  }
  return { items, warnings, suspicious };
}

// 解析术语表（多 sheet）
function parseTermSheet(
  rows: string[][],
  source: string,
): { items: VocabItem[]; warnings: string[] } {
  const items: VocabItem[] = [];
  const warnings: string[] = [];
  const { paper, sub } = paperInfo(source);
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
      id: stableId('term', english, paper, sub, unitsForRaw(source, 'term', english)),
      type: 'term',
      term: english,
      chinese,
      definition,
      paper,
      category: sub,
      unit: unitsForRaw(source, 'term', english),
    });
  }

  if (items.length === 0) {
    warnings.push(`术语表「${source}」未解析到数据`);
  }
  return { items, warnings };
}

// 主入口：解析一个 Excel 文件（可能含多 sheet）
export async function parseExcelFile(file: File): Promise<ImportResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const items: VocabItem[] = [];
  const warnings: string[] = [];
  const suspicious: string[] = [];
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
      suspicious.push(...res.suspicious);
    } else {
      const res = parseTermSheet(rows as string[][], sheetName);
      items.push(...res.items);
      warnings.push(...res.warnings);
    }
  }

  const termCount = items.filter((i) => i.type === 'term').length;
  const scholarCount = items.filter((i) => i.type === 'scholar').length;
  const papers = [...new Set(items.map((i) => i.paper).filter(Boolean))].sort();
  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
  const suspiciousScholars = [...new Set(suspicious)];

  return { items, termCount, scholarCount, papers, categories, warnings, suspiciousScholars };
}

// 批量解析多个文件
export async function parseExcelFiles(files: File[]): Promise<ImportResult> {
  const allItems: VocabItem[] = [];
  const allWarnings: string[] = [];
  const allSuspicious: string[] = [];
  for (const file of files) {
    try {
      const res = await parseExcelFile(file);
      allItems.push(...res.items);
      allWarnings.push(...res.warnings);
      allSuspicious.push(...res.suspiciousScholars);
    } catch (e) {
      allWarnings.push(`读取「${file.name}」失败：${(e as Error).message}`);
    }
  }
  const termCount = allItems.filter((i) => i.type === 'term').length;
  const scholarCount = allItems.filter((i) => i.type === 'scholar').length;
  const papers = [...new Set(allItems.map((i) => i.paper).filter(Boolean))].sort();
  const categories = [...new Set(allItems.map((i) => i.category).filter(Boolean))].sort();
  const suspiciousScholars = [...new Set(allSuspicious)];
  return { items: allItems, termCount, scholarCount, papers, categories, warnings: allWarnings, suspiciousScholars };
}
