import type { VocabItem } from './types';

// 规范化序列化：对象键按字典序排序后输出，保证「语义相同」的两个对象得到相同字符串。
//
// 为什么不能直接用 JSON.stringify：对象字面量的键顺序不同（例如编辑表单重建出的对象与
// 原始导入对象键序不同）、显式 `undefined` 字段，都会让朴素序列化结果不一致，
// 从而把「其实没改动」的保存误判成有改动。
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return v;
}

/** 词库内容指纹：语义相同 → 指纹相同（键顺序、显式 undefined 均不影响） */
export function vocabSnapshotKey(items: VocabItem[]): string {
  return JSON.stringify(canonicalize(items));
}
