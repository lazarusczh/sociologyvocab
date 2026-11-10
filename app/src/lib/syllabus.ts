// 大纲（syllabus）适配层
//
// 背景：本项目的词库内容长期是单一 syllabus（9699，Cambridge AS/A Level Sociology）的形状：
// 词条自带 paper = 'Paper 1'..'Paper 4'，category 是 Family / Education / Globalisation / Media，
// 单元排序也硬编码在这套结构上。
//
// 现在要引入第二个 syllabus（0495，Cambridge IGCSE Sociology），它只有两卷，
// 且卷的划分与 9699 不同：
//   0495 Paper 1 = 研究方法 + 身份 + 分层（≈ 9699 Paper 1 全部）
//   0495 Paper 2 = 家庭 + 教育（≈ 9699 Paper 2 + Paper 3）
//   9699 Paper 4（Globalisation / Media）在 0495 里不存在
//
// 本模块只做一件事：把「词条自带的 9699 形状」投影成「某个 syllabus 下的展示形状」。
// 刻意不做的事：
//   · 不改词条本体（paper/category/unit/id 全部保持原值）—— 这样 stableId 输入不变，
//     同一条词在两个 syllabus 下 id 相同，学生进度天然互认，不需要任何迁移。
//   · 不复制词库 —— 0495 默认「投影」9699 的词条，只有 0495 教师改过的条目才走
//     vocab_overrides 覆盖层（见 db-migration-roles-and-ownership.sql）。
//   · 不引入科目注册表 / import.meta.glob —— 目前只有社会学一科两个 syllabus，
//     注册制是给「多科目」准备的，现在做是过度设计（方案 §3.1 有记录）。

import type { VocabItem } from './types';

export type SyllabusId = '9699' | '0495';

/** 默认 syllabus：所有找不到归属的场景一律回落到它，保证现有行为零变化。 */
export const DEFAULT_SYLLABUS: SyllabusId = '9699';

export interface SyllabusPaper {
  /** 内部稳定 id，用于比较与存储，不随展示名变化 */
  id: string;
  /** 展示名（界面上看到的卷名） */
  tag: string;
}

export interface SyllabusDef {
  id: SyllabusId;
  label: string;
  papers: SyllabusPaper[];
  /**
   * 词条 paper → 本 syllabus 下的卷 id。
   * 键是词条里实际存的 9699 卷名，值是本 syllabus 的卷 id。
   * 未列出的键视为「本 syllabus 不展示该卷」。
   */
  paperMap: Record<string, string>;
  /**
   * 额外放行的术语（大小写不敏感）。
   * 用于处理「卷被裁掉了，但个别术语在本 syllabus 里仍然要考」的例外，
   * 例如分层/全球化里少数概念在 0495 的 P1 里仍会出现。
   */
  borrowTerms?: string[];
  /**
   * 本 syllabus 下整类屏蔽的词条类型。
   *
   * 0495 只在大纲的「关键研究」里点到方法论学者，原则上不要求学生记学者姓名
   * （10 分题里的「研究者」通常是题干给定的），所以学者词条一律不进 0495 视图。
   * 屏蔽只发生在视图投影这一层：词条本体、id、进度都照旧，9699 一条不受影响。
   */
  hideTypes?: Array<VocabItem['type']>;
}

/**
 * 词条是否被该 syllabus 整类屏蔽（见 SyllabusDef.hideTypes）。
 * 这是「视图层」判定，不改词条本体——换回 9699 时同一个 id 立刻恢复可见。
 */
export function hiddenByType(item: VocabItem, syllabus: SyllabusId): boolean {
  const def = SYLLABI[syllabus] ?? P9699;
  return def.hideTypes?.includes(item.type) ?? false;
}

/**
 * 词条是否属于某个 syllabus 的「专属内容」。
 *
 * `VocabItem.syllabus` 不填 = 所有大纲共享（现有 889 条全部如此，行为零变化）；
 * 填了值 = 只在该大纲视图里出现。这是 0495 补充词条对 9699 零影响的关键：
 * 补充词条带 `syllabus: '0495'`，9699 侧一条都不会看到。
 */
export function itemBelongsTo(item: VocabItem, syllabus: SyllabusId): boolean {
  if (!item.syllabus) return true;
  return item.syllabus === syllabus;
}

const P9699: SyllabusDef = {
  id: '9699',
  label: '9699 AS/A Level',
  papers: [
    { id: 'p1', tag: 'Paper 1' },
    { id: 'p2', tag: 'Paper 2' },
    { id: 'p3', tag: 'Paper 3' },
    { id: 'p4', tag: 'Paper 4' },
  ],
  // 恒等映射：9699 是词库的原生形状，投影必须是空操作
  paperMap: {
    'Paper 1': 'p1',
    'Paper 2': 'p2',
    'Paper 3': 'p3',
    'Paper 4': 'p4',
  },
};

const P0495: SyllabusDef = {
  id: '0495',
  label: '0495 IGCSE',
  papers: [
    { id: 'p1', tag: 'Paper 1' },
    { id: 'p2', tag: 'Paper 2' },
  ],
  paperMap: {
    'Paper 1': 'p1', // 研究方法 / 身份 / 分层
    'Paper 2': 'p2', // 家庭
    'Paper 3': 'p2', // 教育 —— 0495 与家庭同卷
    // Paper 4（Globalisation / Media）在 0495 中不存在，故不列出
  },
  // 0495 不考学者姓名：149 条学者词条全部不进 0495 视图（剩 583 条术语）
  hideTypes: ['scholar'],
};

/** 全部已定义的 syllabus。新增 syllabus 只往这里加一条，其余代码不用改。 */
export const SYLLABI: Record<SyllabusId, SyllabusDef> = {
  '9699': P9699,
  '0495': P0495,
};

export const SYLLABUS_IDS = Object.keys(SYLLABI) as SyllabusId[];

/** 下拉框用：value + 展示名 */
export const SYLLABUS_OPTIONS = SYLLABUS_IDS.map((id) => ({ value: id, label: SYLLABI[id].label }));

/** id → 展示名（班级表格等处直接用） */
export const SYLLABUS_LABELS: Record<string, string> = Object.fromEntries(
  SYLLABUS_IDS.map((id) => [id, SYLLABI[id].label]),
);

/** 把任意输入（数据库里的文本列、localStorage 里的旧值、undefined）归一成合法 syllabus id */
export function normalizeSyllabus(raw: unknown): SyllabusId {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s in SYLLABI) return s as SyllabusId;
  return DEFAULT_SYLLABUS;
}

export function getSyllabus(raw: unknown): SyllabusDef {
  return SYLLABI[normalizeSyllabus(raw)];
}

/**
 * 词条在指定 syllabus 下属于哪一卷（返回 syllabus 内部的卷 id）。
 * 返回 null = 该 syllabus 下不展示这条。
 */
export function paperIdFor(item: VocabItem, syllabus: SyllabusId): string | null {
  const def = SYLLABI[syllabus] ?? P9699;
  const mapped = def.paperMap[item.paper];
  if (mapped) return mapped;
  // 例外放行：卷被裁掉、但术语本身仍要考
  if (def.borrowTerms?.length) {
    const key = item.term.trim().toLowerCase();
    if (def.borrowTerms.some((t) => t.trim().toLowerCase() === key)) {
      // 借用进来的词条挂到该 syllabus 的第一卷（0495 的例外词都属研究方法/身份语境）
      return def.papers[0]?.id ?? null;
    }
  }
  return null;
}

/** 词条在指定 syllabus 下的展示卷名（如 'Paper 2'）；null = 不展示 */
export function paperTagFor(item: VocabItem, syllabus: SyllabusId): string | null {
  const def = SYLLABI[syllabus] ?? P9699;
  const pid = paperIdFor(item, syllabus);
  if (!pid) return null;
  return def.papers.find((p) => p.id === pid)?.tag ?? null;
}

/**
 * 该 syllabus 下可见的全部词条（未做 category/unit 过滤）。
 *
 * 9699 是词库的原生形状，绝大多数时候应当原样返回同一数组引用（省 re-render）。
 * 只有当词库里真的存在「不属于本 syllabus」的专属词条时才重建数组——
 * 这也是现有 889 条在 9699 下行为完全不变的原因（一次 some() 就返回）。
 */
export function visibleItems(items: VocabItem[], syllabus: SyllabusId): VocabItem[] {
  const def = SYLLABI[syllabus] ?? P9699;
  const hides = def.hideTypes?.length ? def.hideTypes : null;
  if (def.id === DEFAULT_SYLLABUS && !hides) {
    // 快路径：没有 0495 专属词条时原样返回
    if (!items.some((i) => !itemBelongsTo(i, syllabus))) return items;
    return items.filter((i) => itemBelongsTo(i, syllabus));
  }
  return items.filter(
    (i) => itemBelongsTo(i, syllabus) && !hiddenByType(i, syllabus) && paperIdFor(i, syllabus) !== null,
  );
}

/**
 * 投影：把词条列表换成「该 syllabus 下的展示形状」。
 *
 * 只替换 paper 字段（Paper 3 → Paper 2 这类），id / term / category / unit 一律不动。
 * 这样所有既有组件里 `i.paper === paper` 的判断逻辑一行都不用改，
 * 只要把数据源从 vocab 换成投影后的列表即可。
 *
 * 9699 走快路径：原样返回同一个数组引用（保证 memo/effect 不会因新数组反复触发）。
 */
export function projectItems(items: VocabItem[], syllabus: SyllabusId): VocabItem[] {
  const def = SYLLABI[syllabus] ?? P9699;
  const hides = def.hideTypes?.length ? def.hideTypes : null;

  if (def.id === DEFAULT_SYLLABUS && !hides) {
    // 9699 的 paperMap 是恒等映射，唯一要做的是剔掉 0495 专属词条
    if (!items.some((i) => !itemBelongsTo(i, syllabus))) return items;
    return items.filter((i) => itemBelongsTo(i, syllabus));
  }

  const out: VocabItem[] = [];
  for (const i of items) {
    if (!itemBelongsTo(i, syllabus)) continue;
    if (hiddenByType(i, syllabus)) continue; // 整类屏蔽（0495 不看学者词条）
    const tag = paperTagFor(i, syllabus);
    if (!tag) continue; // 该 syllabus 下不展示
    out.push(tag === i.paper ? i : { ...i, paper: tag });
  }
  return out;
}

/** 该 syllabus 下实际会出现的卷名列表（按 SyllabusDef 顺序） */
export function papersFor(syllabus: SyllabusId): string[] {
  return (SYLLABI[syllabus] ?? P9699).papers.map((p) => p.tag);
}

/**
 * 反查：某个展示卷名下，聚合了哪些「词条原生卷名」。
 * 0495 的 Paper 2 = 原生 Paper 2（Family）+ Paper 3（Education），
 * 所以单元列表、计数等凡是按原生 paper 字段算的地方都要用它展开。
 * 9699 恒等返回 [paper]。
 */
export function nativePapersFor(paperTag: string, syllabus: SyllabusId): string[] {
  const def = SYLLABI[syllabus] ?? P9699;
  const pid = def.papers.find((p) => p.tag === paperTag)?.id;
  if (!pid) return [paperTag];
  const out = Object.keys(def.paperMap).filter((k) => def.paperMap[k] === pid);
  return out.length ? out : [paperTag];
}

/** 词条在指定 syllabus 下是否属于某个展示卷（paper 传 'all' 时恒真） */
export function itemInPaper(item: VocabItem, paperTag: string, syllabus: SyllabusId): boolean {
  if (paperTag === 'all') return true;
  return paperTagFor(item, syllabus) === paperTag;
}
