// OCR 阅卷高亮：把视觉模型转写的答卷文本与词库做**容错匹配**（纯前端、零后端、零词库改动）。
//
// 与《OCR辅助阅卷.md》一致：不与判分 aliases 耦合 —— 判分是"这是对的答案"（严格、要准），
// 高亮是"这疑似某术语"（概率性、教师复核、误标无代价）。
//
// 四档标记：
//   exact   精确命中        （实心高亮 + 词库定义）
//   variant 同词根变形      （education/educational、functionalism/functionalist —— 正常用法，**不打问号**）
//   fuzzy   疑似笔误        （Durkhiem → Durkheim —— 浅红虚线 + ?，交教师确认）
//   level   核心 / 一般      （一般词=高频通用词，默认淡化，见 ocr-term-levels.json）
//
// 归一化口径与判分（answers.ts 的 normalizeKey）同源：忽略大小写、重音、标点、连字符；
// 区别是这里**保留词间空格**（要高亮短语，不能把空格也吃掉）。

import aliasData from './answer-aliases.json';
import levelData from './ocr-term-levels.json';
import type { VocabItem } from './types';

export type HitMode = 'exact' | 'variant' | 'fuzzy';
export type ItemLevel = 'core' | 'general';

export interface OcrHit {
  start: number;
  end: number;
  term: string;                 // 词库词条名
  kind: 'term' | 'scholar';
  level: ItemLevel;
  mode: HitMode;
  surface: string;              // 学生原文中的写法
  suggest?: string;             // 命中的词库写法（variant/fuzzy 时展示）
}

interface FormInfo { kind: 'term' | 'scholar'; term: string; level: ItemLevel }

const SCHOLAR_ALIASES: Record<string, string[]> = aliasData.scholarAliases;
const SURNAME_OVERRIDES: Record<string, string> = aliasData.surnameOverrides;
const GENERIC_TERMS = new Set<string>(((levelData as { general?: string[] }).general ?? []));

const ORG_KEYWORDS = [
  'association', 'centre', 'center', 'government', 'bank', 'court', 'commission',
  'service', 'survey', 'research', 'institute', 'university', 'resource', 'group',
  'movement', 'organisation', 'organization', 'company', 'council', 'committee',
];

/** 归一化：大小写/重音/标点/连字符不敏感，但**保留空格**（用于短语对齐） */
export function normKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/\b([a-z]+?)isation\b/g, '$1ization')
    .replace(/\b([a-z]+?)ise\b/g, '$1ize')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Token { raw: string; key: string; start: number; end: number }

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[A-Za-z][A-Za-z'\-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = normKey(m[0]);
    if (key) out.push({ raw: m[0], key, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const lastWord = (s: string): string => {
  const words = s.replace(/\([^)]*\)/g, ' ').match(/[A-Za-z][A-Za-z'\-]*/g) ?? [];
  return words.length ? words[words.length - 1] : '';
};

/** 单复数变体（value/values、theory/theories） */
function pluralVariants(phrase: string): string[] {
  const w = phrase.split(' ');
  if (!w.length) return [];
  const head = w.slice(0, -1).join(' ');
  const last = w[w.length - 1];
  const out: string[] = [];
  if (last.endsWith('s') && !last.endsWith('ss')) out.push([head, last.slice(0, -1)].filter(Boolean).join(' '));
  else if (last.endsWith('y') && last.length > 3) out.push([head, last.slice(0, -1) + 'ies'].filter(Boolean).join(' '));
  else if (!last.endsWith('s')) out.push([head, last + 's'].filter(Boolean).join(' '));
  return out;
}

// ---- 容错：编辑距离（含换位与 OCR 混淆对，按 0.5/1 计价，与实验室脚本同口径） ----

const CONFUSE = new Set(['l|i', 'l|1', 'i|1', 'o|0', 'o|a', 's|5', 'g|q', 'u|v', 'n|r', 'c|e', 't|f', 'h|b']);
const confusable = (a: string, b: string): boolean => CONFUSE.has(`${a}|${b}`) || CONFUSE.has(`${b}|${a}`);

function distOcr(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev2: number[] | null = null;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i, ...Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : confusable(a[i - 1], b[j - 1]) ? 0.5 : 1;
      let best = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2[j - 2] + 1); // 换位
      }
      cur[j] = best;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** 容错判定：首字母必须一致；短词只接受 OCR 混淆级别的差异 */
function acceptHit(phrase: string, cand: string, d: number): boolean {
  if (!phrase || !cand || phrase[0] !== cand[0]) return false;
  const L = phrase.length;
  if (L <= 5) return d <= 0.5;
  if (L <= 8) return d <= 1;
  if (L <= 14) return d <= 2;
  return d <= 3 && d / L <= 0.18;
}

// 派生后缀（长后缀在前），用于识别「同词根变形」而非「笔误」
const DERIV_SUFFIX = ['istic', 'ation', 'ical', 'ism', 'ist', 'ion', 'ity', 'ive', 'ally', 'al', 'ic', 'ly', 'ness', 'er', 'or', 'ed', 'ing', 's'];

function stemOf(word: string): string {
  for (const suf of DERIV_SUFFIX) {
    if (word.endsWith(suf) && word.length - suf.length >= 5) return word.slice(0, -suf.length);
  }
  return word;
}

/** 同词根变形（education/educational、functionalism/functionalist）——正常用法，不是笔误 */
export function isVariant(phrase: string, cand: string): boolean {
  if (!phrase || !cand || phrase[0] !== cand[0]) return false;
  const sp = stemOf(phrase);
  const sc = stemOf(cand);
  if (sp === sc && sp.length >= 5) return true;
  return sp === cand || sc === phrase;
}

// ---- 词形表：词库 → 所有可接受写法 ----

export interface FormTable {
  forms: Map<string, FormInfo>;
  maxWords: number;
  counts: { terms: number; scholars: number };
}

export function buildFormTable(vocab: VocabItem[]): FormTable {
  const forms = new Map<string, FormInfo>();
  let termCount = 0;
  let scholarCount = 0;
  const put = (key: string, info: FormInfo) => {
    if (key.length >= 3 && !forms.has(key)) forms.set(key, info);
  };
  for (const item of vocab) {
    const kind: 'term' | 'scholar' = item.type === 'scholar' ? 'scholar' : 'term';
    // 学者一律「核心」；术语按分级表（多词短语天然有区分度）
    const level: ItemLevel = kind === 'scholar' ? 'core' : GENERIC_TERMS.has(item.term) ? 'general' : 'core';
    if (kind === 'scholar') scholarCount++;
    else termCount++;

    const info: FormInfo = { kind, term: item.term, level };
    const cands = new Set<string>([item.term, ...(item.aliases ?? [])]);
    if (kind === 'scholar') {
      for (const a of SCHOLAR_ALIASES[item.term] ?? []) cands.add(a);
      const ov = SURNAME_OVERRIDES[item.term];
      if (ov) cands.add(ov);
      const clean = item.term.replace(/\([^)]*\)/g, ' ');
      if (/et\s+al/i.test(item.term)) cands.add(lastWord(item.term.split(/et\s+al/i)[0]));
      else if (/[&,]/.test(clean)) {
        for (const seg of clean.split(/[&,]/)) if (seg.trim()) cands.add(lastWord(seg));
      } else if (!ORG_KEYWORDS.some((k) => clean.toLowerCase().includes(k))) cands.add(lastWord(clean));
    } else {
      for (const base of [...cands]) for (const v of pluralVariants(normKey(base))) cands.add(v);
    }
    for (const c of cands) put(normKey(c), info);
  }
  return { forms, maxWords: Math.max(1, ...[...forms.keys()].map((f) => f.split(' ').length)), counts: { terms: termCount, scholars: scholarCount } };
}

/** 在转写文本里做容错匹配，返回不重叠的命中（按出现顺序） */
export function matchTranscript(text: string, table: FormTable): OcrHit[] {
  const toks = tokenize(text);
  const keys = toks.map((t) => t.key);
  const used = new Set<number>();
  const hits: OcrHit[] = [];

  // ① 精确：多词优先（最长匹配）
  for (let i = 0; i < toks.length; i++) {
    for (let n = Math.min(table.maxWords, toks.length - i); n >= 1; n--) {
      let blocked = false;
      for (let k = 0; k < n; k++) if (used.has(i + k)) { blocked = true; break; }
      if (blocked) continue;
      const phrase = keys.slice(i, i + n).join(' ');
      const info = table.forms.get(phrase);
      if (info) {
        hits.push({
          start: toks[i].start, end: toks[i + n - 1].end, term: info.term, kind: info.kind,
          level: info.level, mode: 'exact', surface: text.slice(toks[i].start, toks[i + n - 1].end),
        });
        for (let k = 0; k < n; k++) used.add(i + k);
        break;
      }
    }
  }

  // ② 容错：精确未占用的词，最多 2 词短语，编辑距离分级
  const entries = [...table.forms.entries()];
  for (let i = 0; i < toks.length; i++) {
    if (used.has(i)) continue;
    for (const n of [2, 1]) {
      if (i + n > toks.length) continue;
      let blocked = false;
      for (let k = 0; k < n; k++) if (used.has(i + k)) { blocked = true; break; }
      if (blocked) continue;
      const phrase = keys.slice(i, i + n).join(' ');
      if (phrase.length <= 3) continue;
      let best: { d: number; key: string; info: FormInfo } | null = null;
      for (const [cand, info] of entries) {
        if (Math.abs(cand.length - phrase.length) > 4) continue;
        const d = distOcr(phrase, cand, 3);
        if (acceptHit(phrase, cand, d) && (!best || d < best.d)) best = { d, key: cand, info };
      }
      if (best) {
        const variant = isVariant(phrase, best.key);
        hits.push({
          start: toks[i].start, end: toks[i + n - 1].end, term: best.info.term, kind: best.info.kind,
          level: best.info.level, mode: variant ? 'variant' : 'fuzzy',
          surface: text.slice(toks[i].start, toks[i + n - 1].end), suggest: best.key,
        });
        for (let k = 0; k < n; k++) used.add(i + k);
        break;
      }
    }
  }

  return hits.sort((a, b) => a.start - b.start);
}

export interface HighlightStats {
  terms: number;
  scholars: number;
  generalHits: number;
  variantHits: number;
  fuzzyHits: number;
}

export function summarize(hits: OcrHit[]): HighlightStats {
  return {
    terms: new Set(hits.filter((h) => h.kind === 'term').map((h) => h.term)).size,
    scholars: new Set(hits.filter((h) => h.kind === 'scholar').map((h) => h.term)).size,
    generalHits: hits.filter((h) => h.level === 'general').length,
    variantHits: hits.filter((h) => h.mode === 'variant').length,
    fuzzyHits: hits.filter((h) => h.mode === 'fuzzy').length,
  };
}
