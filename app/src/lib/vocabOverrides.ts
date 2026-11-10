// 词条覆盖层（vocab_overrides）的运行时合并
//
// 背景（与 db-migration-roles-and-ownership.sql 第 5 节对应）：
//   0495 默认复用 9699 的词库，是一种「运行时投影」。一旦 0495 教师改了某条词条，
//   既不能改 9699 的原始行（9699 学生会跟着变），也不能复制整份词库
//   （id 会分叉、学生进度对不上）。所以改动只以「差异」的形式存在 vocab_overrides，
//   由本模块在运行时合并到基础词库上。
//
// 三种操作：
//   edit → patch 里的字段覆盖到基础词条上，**id 保持不变**（这是学生进度能对上的关键）
//   hide → 该 syllabus 下隐藏这条基础词条
//   add  → patch 本身就是一条完整词条，只在该 syllabus 下可见
//
// 注意：合并只发生在内存里，落盘的永远是 9699 的原生词库（见 store.tsx syncVocabFromCloud）。

import type { VocabItem } from './types';

export type OverrideOp = 'edit' | 'hide' | 'add';

export interface VocabOverride {
  syllabus: string;
  item_id: string;
  op: OverrideOp;
  patch: Partial<VocabItem> & { term?: string };
}

/**
 * 把覆盖层合并到词条列表上。返回新数组（不改入参）。
 *
 * 顺序：先处理 edit / hide（作用于已有词条），再追加 add（新词条）。
 * 这样 add 的条目不会被同一批里的 edit 意外命中（两者的 item_id 语义不同）。
 */
export function applyVocabOverrides(items: VocabItem[], overrides: VocabOverride[]): VocabItem[] {
  if (!overrides.length) return items;

  const byId = new Map<string, VocabOverride>();
  for (const o of overrides) byId.set(o.item_id, o);

  const out: VocabItem[] = [];
  const mergedAddIds = new Set<string>();
  for (const item of items) {
    const o = byId.get(item.id);
    if (!o) {
      out.push(item);
      continue;
    }
    if (o.op === 'hide') continue;
    if (o.op === 'edit') {
      // id 必须保留：stableId 由 term/paper/category/unit 决定，
      // 一旦教师改了 term 或 unit，重算 id 会让学生的掌握度/错题记录对不上。
      out.push({ ...item, ...o.patch, id: item.id });
      continue;
    }
    // op='add' 却撞上了已存在的 id：视为「替换」，同样保 id。
    // 记下 id，避免下面追加 add 时又推一条同样的条目（会重复渲染）。
    mergedAddIds.add(item.id);
    out.push({ ...item, ...o.patch, id: item.id });
  }

  // 追加 add：只有在该 syllabus 下新增的条目
  for (const o of overrides) {
    if (o.op !== 'add') continue;
    if (mergedAddIds.has(o.item_id)) continue;
    const p = o.patch as Partial<VocabItem>;
    if (!p.term || !p.definition) continue; // 数据不完整就不展示，避免渲染空卡片
    out.push({
      id: o.item_id,
      type: p.type ?? 'term',
      term: p.term,
      chinese: p.chinese ?? '',
      definition: p.definition,
      paper: p.paper ?? 'Paper 1',
      category: p.category ?? '',
      ...(p.unit ? { unit: p.unit } : {}),
      ...(p.aliases ? { aliases: p.aliases } : {}),
      ...(p.theories ? { theories: p.theories } : {}),
    });
  }
  return out;
}

/**
 * 覆盖层的「期望基线」：某个 syllabus 下被改过的 id 集合。
 * 供教师端提示「这一条在本大纲下已被改写」用。
 */
export function overriddenIds(overrides: VocabOverride[]): Set<string> {
  return new Set(overrides.filter((o) => o.op !== 'add').map((o) => o.item_id));
}
