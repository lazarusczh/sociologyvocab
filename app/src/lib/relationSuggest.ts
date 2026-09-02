// 逻辑关系·编辑助手：启发式推荐「可能相关且尚未入网」的词条（P0，零依赖）
// 信号：① 释义提及（anchor 出现在候选释义里，最强）② 同单元共现
//       ③ 名称相关（term 包含 / 英文词级共享 / 中文包含）
// 定位：教师保存一条逻辑关系后，在下方提示候选词，点击直接载入 B 多选框，提高网络覆盖率。
import type { VocabItem } from './types';
import { scholarSurnames, normalizeKey } from './answers';

// ---- 概念组归并（LogicManager / conceptGraph 共用）----
// 按 type + 归一化后的 term 归并：斜杠/括号/重音/大小写等写法差异不再导致同概念分裂。
// 例："Deferred / Delayed gratification" 与 "Deferred (delayed) gratification"、
//     "Émile Durkheim" 与 "Emile Durkheim" 均归为同一概念组。
// 若未来需「同 term 但语义不同」拆组（如按 unit），在此按原始 term 判断后追加 unit 维度。
export function conceptIdOf(item: VocabItem): string {
  return `${item.type}|${normalizeKey(item.term)}`;
}

const normEn = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normCn = (s: string) => (s || '').toLowerCase().replace(/[\s，。、：；（）()·_-]/g, '');
const words = (s: string) => (s || '').toLowerCase().match(/[a-z]+/g) ?? [];

// 名称相关度：只用有逻辑的强信号——
// ① term 包含关系（Socialisation ↔ Secondary socialisation）
// ② 英文词级共享（Primary ↔ Secondary socialisation 共享 socialisation；短虚词不计）
// ③ 中文包含关系（"制度化的种族主义" ↔ "种族主义"）
// 不用「字形/字符重叠」：无语义，会匹配到偶然同字母的无关词
function textSim(a: VocabItem, b: VocabItem): number {
  const t1 = normEn(a.term);
  const t2 = normEn(b.term);
  if (t1 && t2 && (t1.includes(t2) || t2.includes(t1))) return 0.95;
  const w1 = words(a.term).filter((w) => w.length >= 4);
  const w2 = new Set(words(b.term).filter((w) => w.length >= 4));
  if (w1.length && [...w2].some((w) => w1.includes(w))) return 0.7; // 共享核心词
  const c1 = normCn(a.chinese);
  const c2 = normCn(b.chinese);
  if (c1 && c2 && (c1.includes(c2) || c2.includes(c1))) return 0.9;
  return 0;
}

export interface RelationSuggestion {
  item: VocabItem;
  reasons: string[]; // 如 ['同单元', '名称相近']
}

// 推荐「与 anchor 相关、但尚未进入关系网络」的词条，按相关度降序取 top-limit。
// excludeIds：调用方可排除已选/已显示的词条，避免重复推荐。
export function suggestRelated(vocab: VocabItem[], anchor: VocabItem, excludeIds: string[] = [], limit = 6): RelationSuggestion[] {
  const anchorCid = conceptIdOf(anchor);
  const excluded = new Set(excludeIds);

  // 已入网概念组：存在任意关系边即视为已覆盖
  const inNetwork = new Set<string>();
  for (const it of vocab) {
    if (it.relations && Object.keys(it.relations).length) inNetwork.add(conceptIdOf(it));
  }

  // 释义引用形式：anchor 的 term/别名/姓氏（归一化后，长度>=4）——
  // 若出现在某候选的释义里，说明候选在解释时依赖/提到了该概念
  const anchorForms = new Set<string>();
  const addForm = (s: string) => {
    const k = normEn(s);
    if (k && k.length >= 4) anchorForms.add(k);
  };
  addForm(anchor.term);
  (anchor.aliases ?? []).forEach(addForm);
  try {
    scholarSurnames(anchor.term).forEach(addForm); // 学者：释义里常写姓氏（如 Beck）
  } catch {
    /* 姓氏提取异常时忽略该形式 */
  }

  const anchorUnits = new Set(anchor.unit ?? []);
  const scored: { item: VocabItem; score: number; reasons: string[] }[] = [];

  for (const it of vocab) {
    const cid = conceptIdOf(it);
    if (cid === anchorCid) continue; // 同一概念组，无需关系
    if (inNetwork.has(cid)) continue; // 只推尚未入网的
    if (excluded.has(it.id)) continue;

    const reasons: string[] = [];
    let score = 0;

    const overlap = (it.unit ?? []).filter((u) => anchorUnits.has(u)).length;
    if (overlap > 0) {
      reasons.push('同单元');
      score += 100 + overlap * 20;
    }
    const ts = textSim(anchor, it);
    if (ts >= 0.5) {
      reasons.push('名称相关');
      score += 50 + Math.round(ts * 50);
    }

    // 释义提及：anchor 的形式出现在候选释义里（容忍词尾复数）→ 最强信号
    const defKey = normEn(it.definition ?? '');
    if (defKey && anchorForms.size) {
      for (const f of anchorForms) {
        if (defKey.includes(f) || defKey.includes(f + 's')) {
          reasons.push('释义提及');
          score += 120;
          break;
        }
      }
    }

    if (score === 0) continue;
    scored.push({ item: it, score, reasons });
  }

  return scored
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ item, reasons }) => ({ item, reasons }));
}
