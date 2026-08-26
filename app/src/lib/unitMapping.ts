import type { VocabItem } from './types';
import rawMapping from './unit-mapping.json';

// 原始主题 → { 考卷 Paper, 次级标签 sub }（与 generate-vocab.mjs / excelImport.ts 保持一致）
export const CATEGORY_TO_PAPER: Record<string, { paper: string; sub: string }> = {
  'Social theories & socialisation': { paper: 'Paper 1', sub: '' },
  'Research methods': { paper: 'Paper 1', sub: '' },
  'Social identities': { paper: 'Paper 1', sub: '' },
  'Socialisation Methodology Identity': { paper: 'Paper 1', sub: '' },
  'Family': { paper: 'Paper 2', sub: 'Family' },
  'Education': { paper: 'Paper 3', sub: 'Education' },
  'Globalisation': { paper: 'Paper 4', sub: 'Globalisation' },
  'Media': { paper: 'Paper 4', sub: 'Media' },
};

// 单元展示顺序（按教学大纲 unit 编号，key = `paper|sub`）
export const UNIT_ORDER: Record<string, string[]> = {
  'Paper 1|': ['社会理论', '社会化和社会控制', '社会认同基础', '阶级认同', '性别认同', '族裔认同', '年龄认同', '研究方法', '研究设计', '方法论取向', '研究议题'],
  'Paper 2|Family': ['家庭功能', '家庭多样性', '社会政策与家庭变迁', '性别平等', '年龄角色'],
  'Paper 3|Education': [
    '教育功能', '课程影响', '智力与学业成就',
    '社会阶层与学业成就', '族群与学业成就', '教育与不平等', '性别与学业成就',
  ],
  'Paper 4|Globalisation': ['理论视角与核心概念', '全球犯罪与不平等', '全球化移民', '人权、发展与全球治理'],
  'Paper 4|Media': ['媒体所有权与控制', '媒体再现与效果'],
};

const UNIT_ORDER_KEY = 'socio_vocab_unit_order';

// 读取本地自定义的单元列表（合并默认 + localStorage 覆盖；无则返回默认副本）
export function loadUnitOrder(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(UNIT_ORDER_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, string[]>;
      return { ...UNIT_ORDER, ...saved };
    }
  } catch {
    // 解析失败时回退默认
  }
  return { ...UNIT_ORDER };
}

// 保存自定义单元列表到本地
export function saveUnitOrder(order: Record<string, string[]>): void {
  localStorage.setItem(UNIT_ORDER_KEY, JSON.stringify(order));
}

// 某 paper 下的次级标签列表（Paper 1 为 ['']，Paper 4 为 ['Globalisation','Media']）
export function subsForPaper(paper: string, order?: Record<string, string[]>): string[] {
  const src = order ?? UNIT_ORDER;
  return Object.keys(src)
    .filter((k) => k.startsWith(`${paper}|`))
    .map((k) => k.slice(paper.length + 1));
}

type RawMapping = Record<string, Record<string, Record<string, string[]>>>;
const M = rawMapping as RawMapping;

// 按原始主题 + 类型 + 术语查单元（用于 generate/import 阶段，此时原始 category 尚在）
export function unitsForRaw(category: string, type: string, term: string): string[] {
  return M[category]?.[type]?.[term] ?? [];
}

// 建立 `paper|sub` → type → term → units 索引（union 合并跨原始主题的冲突，如 Paper 1 的 Cultural deprivation）
const paperSubIndex: Record<string, Record<string, Record<string, string[]>>> = {};
for (const [cat, byType] of Object.entries(M)) {
  const { paper, sub } = CATEGORY_TO_PAPER[cat] ?? { paper: 'Paper 1', sub: cat };
  const key = `${paper}|${sub}`;
  paperSubIndex[key] = paperSubIndex[key] || {};
  for (const [type, byTerm] of Object.entries(byType)) {
    paperSubIndex[key][type] = paperSubIndex[key][type] || {};
    for (const [term, units] of Object.entries(byTerm)) {
      const cur = paperSubIndex[key][type][term] || [];
      for (const u of units) if (!cur.includes(u)) cur.push(u);
      paperSubIndex[key][type][term] = cur;
    }
  }
}

// 给缺 unit 的词条补上 unit-mapping 映射；已有 unit 的（用户手动设置/导入已带）不覆盖。
// 注意：不要覆盖已存在的 unit，否则用户手动改选/重命名的单元会在刷新后被 unit-mapping.json 重算回旧值。
export function attachUnits(items: VocabItem[]): VocabItem[] {
  return items.map((i) => {
    if (i.unit && i.unit.length > 0) return i; // 已有单元，保留
    const units = paperSubIndex[`${i.paper}|${i.category}`]?.[i.type]?.[i.term];
    return units && units.length ? { ...i, unit: units } : i;
  });
}

// 某 paper+category 下的单元（按大纲顺序；order 为自定义单元列表，缺省用默认）
export function unitOrderFor(paper: string, category: string, order?: Record<string, string[]>): string[] {
  return (order ?? UNIT_ORDER)[`${paper}|${category}`] ?? [];
}

// 某 paper+category 当前应展示的单元列表：
// - Paper 1/2/3 各自只有一个（或零个）次级标签，直接取该标签下的单元
// - Paper 4 有两个次级标签（Globalisation/Media），需先选主题，否则不展示单元
export function unitListFor(items: VocabItem[], paper: string, cat: string, order?: Record<string, string[]>): string[] {
  if (paper === 'all') return [];
  const cats = [...new Set(items.filter((i) => i.paper === paper).map((i) => i.category).filter(Boolean))];
  const effCat = cats.length <= 1 ? (cats[0] ?? '') : cat;
  return unitOrderFor(paper, effCat, order);
}

// 某 paper 下的所有单元（Paper 4 合并 Globalisation/Media；order 缺省用默认）
export function unitsForPaper(paper: string, order?: Record<string, string[]>): string[] {
  const src = order ?? UNIT_ORDER;
  const units = new Set<string>();
  for (const [key, list] of Object.entries(src)) {
    if (key.startsWith(`${paper}|`)) list.forEach((u) => units.add(u));
  }
  return [...units];
}
