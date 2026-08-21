// 答案判定与容错逻辑
import type { VocabItem } from './types';
import { loadSurnameOverrides } from './storage';

// 归一化：忽略大小写、空格、连字符、标点、重音等，只保留小写字母与数字
export function normalizeKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // 去变音符号（é->e, ü->u …）
    .toLowerCase()
    .replace(/\b([a-z]+?)isation\b/g, '$1ization') // 英式 -isation -> 美式 -ization
    .replace(/\b([a-z]+?)ise\b/g, '$1ize') // 英式 -ise -> 美式 -ize
    .replace(/[^a-z0-9]/g, '');
}

// 术语的"多种同义/等价写法"映射：键为词库原文，值为所有可接受写法
const TERM_ALIASES: Record<string, string[]> = {
  'Hawthorne effect (observer effect)': ['Hawthorne effect', 'observer effect'],
  'Primary (first-hand) research': ['primary research', 'first-hand research'],
  'Aristocrat (landed aristocrat)': ['Aristocrat', 'landed aristocrat'],
  'Multiculturalism (= Cultural diversity)': ['Multiculturalism', 'Cultural diversity'],
  'Marxist (socialist) feminism': ['Marxist feminism', 'socialist feminism'],
  'Deferred (delayed) gratification': ['Deferred gratification', 'delayed gratification'],
  'Intelligence Quotient (IQ)': ['Intelligence Quotient', 'IQ'],
  'Anti-Globalisation Movement (AGM)': ['Anti-Globalisation Movement', 'AGM'],
  'Preferred (dominant) reading': ['Preferred reading', 'dominant reading'],
  'Conversion (of capitals)': ['Conversion', 'Conversion of capitals'],
  'Cultural factor (deprivation)': ['Cultural factor', 'cultural deprivation'],
  'Deferred / Delayed gratification': ['Deferred gratification', 'Delayed gratification'],
  'Commune / shared households / Friends as family': [
    'Commune',
    'shared households',
    'Friends as family',
  ],
  'Ethnic / Cultural diversity': ['Ethnic diversity', 'Cultural diversity'],
  'Life course / cycle diversity': ['Life course diversity', 'Life cycle diversity'],
  '‘New Man’ / ‘New Father’': ['New Man', 'New Father'],
  'Single-parent / Lone-parent family': ['Single-parent family', 'Lone-parent family'],
  'Dark web / Dark net': ['Dark web', 'Dark net'],
  'Editorial freedom / independence': ['Editorial freedom', 'Editorial independence'],
  'News values / newsworthiness': ['News values', 'News value', 'newsworthiness'],

  // 单复数放宽：复数名词条目允许单数写法也算对
  'Borderline cases': ['Borderline cases', 'Borderline case'],
  'Educational migrants': ['Educational migrants', 'Educational migrant'],
  'Helicopter parents': ['Helicopter parents', 'Helicopter parent'],
  'Hidden rules': ['Hidden rules', 'Hidden rule'],
  'Hopeless cases': ['Hopeless cases', 'Hopeless case'],
  'Mixed methods': ['Mixed methods', 'Mixed method'],
  'Moral panics': ['Moral panics', 'Moral panic'],
  'Prenups': ['Prenups', 'Prenup'],
  'Joint conjugal roles': ['Joint conjugal roles', 'Joint conjugal role'],
  'Segregated conjugal roles': ['Segregated conjugal roles', 'Segregated conjugal role'],
  'Qualitative research methods': ['Qualitative research methods', 'Qualitative research method'],
  'Quantitative research methods': ['Quantitative research methods', 'Quantitative research method'],
  'Feral children': ['Feral children', 'Feral child'],
  'Folk devils': ['Folk devils', 'Folk devil'],
  'Millenials': ['Millenials', 'Millennial'],
};

// 学者/机构名（含括号、缩写、来源说明等）的等价写法
const SCHOLAR_ALIASES: Record<string, string[]> = {
  'Ulrich Beck (& Elisabeth Beck-Gernsheim)': ['Ulrich Beck', 'Beck'],
  'Michael (Dunlop) Young': ['Michael Young', 'Young'],
  'America Sociology Association (ASA)': ['America Sociology Association', 'ASA'],
  'America Psychology Association (APA)': ['America Psychology Association', 'APA'],
  'Centre for the Modern Family (quoted by Daily Mail)': ['Centre for the Modern Family'],
  'RIAS (Ageas), a British insurance company': ['RIAS'],
  'Glasgow University Media Group (GUMG)': ['Glasgow University Media Group', 'GUMG'],
};

// 特殊姓氏映射：学界以完整笔名称呼的作者，其"姓"是整个笔名而非最后一个词。
// 例：bell hooks 是完整笔名（本名 Gloria Jean Watkins），不能拆成"姓 hooks 名 bell"。
// 键为词库原文 term，值为应作为"姓氏"的完整写法（默写时只答此写法即算对）。
const BUILTIN_SURNAME_OVERRIDES: Record<string, string> = {
  '(Gloria Jean Watkins) bell hooks': 'bell hooks',
};

// 合并内置默认 + 用户手动指定的姓氏覆盖（用户覆盖优先）
function surnameOverrides(): Record<string, string> {
  return { ...BUILTIN_SURNAME_OVERRIDES, ...loadSurnameOverrides() };
}

// 机构/来源特征词：命中则视为非人名，不套用"只认姓氏"
const ORG_KEYWORDS = [
  'association', 'centre', 'center', 'government', 'bank', 'court', 'commission',
  'service', 'survey', 'research', 'institute', 'university', 'resource', 'group',
  'congress', 'council', 'national', 'world',
];

// ---- 单复数互认：通用为术语生成单/复数变体 ----
const IRREGULAR_PLURALS: Record<string, string> = {
  child: 'children',
  person: 'people',
  man: 'men',
  woman: 'women',
  foot: 'feet',
  tooth: 'teeth',
  mouse: 'mice',
  leaf: 'leaves',
  life: 'lives',
  wife: 'wives',
  analysis: 'analyses',
  criterion: 'criteria',
  phenomenon: 'phenomena',
  hypothesis: 'hypotheses',
  thesis: 'theses',
  index: 'indices',
  matrix: 'matrices',
};

const IRREGULAR_SINGULARS: Record<string, string> = {
  children: 'child',
  people: 'person',
  men: 'man',
  women: 'woman',
  feet: 'foot',
  teeth: 'tooth',
  mice: 'mouse',
  leaves: 'leaf',
  lives: 'life',
  wives: 'wife',
  analyses: 'analysis',
  criteria: 'criterion',
  phenomena: 'phenomenon',
  hypotheses: 'hypothesis',
  theses: 'thesis',
  indices: 'index',
  matrices: 'matrix',
  millenials: 'millennial',
};

// 单数 -> 复数（无法可靠复数化时返回 null）
function toPlural(word: string): string | null {
  const w = word.toLowerCase();
  if (IRREGULAR_PLURALS[w]) return IRREGULAR_PLURALS[w];
  if (/(ss|us|is)$/.test(w)) return null; // 本身似单数但不可规则复数
  if (/s$/.test(w)) return null; // 已以 s 结尾，视为复数，不再复数化
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  if (/(x|z|ch|sh)$/.test(w)) return w + 'es';
  return w + 's';
}

// 复数 -> 单数（无法可靠单数化时返回 null）
function toSingular(word: string): string | null {
  const w = word.toLowerCase();
  if (IRREGULAR_SINGULARS[w]) return IRREGULAR_SINGULARS[w];
  if (/ies$/.test(w) && w.length > 3) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return null; // analysis/status/basis 等非简单复数
  if (/(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2); // watches->watch, boxes->box, classes->class
  if (/es$/.test(w)) return w.slice(0, -1); // cases->case, roles->role, values->value
  if (/s$/.test(w)) return w.slice(0, -1);
  return null;
}

// 生成短语最后一个单词的单/复数变体（保留前面的词）
function singularPluralVariants(phrase: string): string[] {
  const trimmed = phrase.trim();
  if (!trimmed) return [];
  const idx = trimmed.lastIndexOf(' ');
  const head = idx === -1 ? '' : trimmed.slice(0, idx + 1);
  const last = trimmed.slice(idx + 1);
  const out: string[] = [];
  const pl = toPlural(last);
  const sg = toSingular(last);
  if (pl) out.push(head + pl);
  if (sg) out.push(head + sg);
  return out;
}

// 短语单数化：仅把最后一个单词转为单数；已单数或无法可靠单数化则保持原样。
// 供纵横填字生成答案使用，避免随机到复数形式让学生对不上格子数。
function toSingularForm(phrase: string): string {
  const trimmed = phrase.trim();
  if (!trimmed) return trimmed;
  const idx = trimmed.lastIndexOf(' ');
  const head = idx === -1 ? '' : trimmed.slice(0, idx + 1);
  const last = trimmed.slice(idx + 1);
  const sg = toSingular(last);
  return sg ? head + sg : trimmed;
}

function lastWord(s: string): string {
  const words = s.trim().split(/\s+/);
  return words[words.length - 1] || '';
}

// 合著条目：将每位作者替换为姓氏，保留原文分隔符（第一、二作者用逗号，第二、三作者用 &）
function coAuthorSurnamesKey(term: string): string {
  return term
    .split(/([&,])/)
    .map((seg) => (/^[&,]$/.test(seg) ? seg : lastWord(seg.replace(/\([^)]*\)/g, ' ').trim())))
    .filter((s) => s.length > 0)
    .join('')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*&\s*/g, ' & ')
    .replace(/\s+/g, ' ')
    .trim();
}

// et al. 条目：第一作者姓氏 + et al.
function firstSurnameEtAl(term: string): string {
  const first = term.split(/et\s+al/i)[0].replace(/\([^)]*\)/g, ' ').trim();
  return `${lastWord(first)} et al`;
}

// 判断学者条目是否为"单人姓名"（适用于只认姓氏的规则）
function isSinglePersonName(term: string): boolean {
  if (term.includes('&')) return false; // 多人合著
  if (/et\s+al/i.test(term)) return false; // 多人 et al.
  const lower = term.toLowerCase();
  for (const kw of ORG_KEYWORDS) {
    if (lower.includes(kw)) return false; // 机构/来源
  }
  const words = term.trim().split(/\s+/);
  return words.length >= 1 && words.length <= 3; // 通常为 First Last 或 First Middle Last
}

// 判断学者名是否为「非常规格式」，需要用户人工指定姓氏处理方式。
// 判定依据：含括号本名/说明、或全小写（疑似笔名）——自动取「最后一个词当姓氏」会出错。
// 已有人工配置（别名 / 姓氏覆盖）或合著 et al. / & 条目的，视为规则已覆盖，不再提示。
export function isSuspiciousScholarName(term: string): boolean {
  if (SCHOLAR_ALIASES[term]) return false;
  if (surnameOverrides()[term]) return false;
  if (/et\s+al/i.test(term)) return false;
  if (term.includes('&')) return false;
  if (/[()]/.test(term)) return true; // 含括号本名/说明
  const letters = term.replace(/[^A-Za-z]/g, '');
  if (letters.length > 0 && letters === letters.toLowerCase()) return true; // 全小写笔名
  return false;
}

// 获取某词条所有可接受写法的归一化键集合
export function getAcceptableKeys(item: VocabItem): string[] {
  const keys = new Set<string>();
  const push = (s: string) => {
    const k = normalizeKey(s);
    if (k) keys.add(k);
  };

  if (item.type === 'term') {
    const list = TERM_ALIASES[item.term] ?? [item.term];
    list.forEach((base) => {
      push(base);
      singularPluralVariants(base).forEach(push);
    });
  } else {
    if (SCHOLAR_ALIASES[item.term]) {
      SCHOLAR_ALIASES[item.term].forEach(push);
    } else if (surnameOverrides()[item.term]) {
      push(item.term); // 完整原文（笔名 + 本名）
      push(surnameOverrides()[item.term]); // 特殊姓氏整体（如 "bell hooks"）
    } else if (/et\s+al/i.test(item.term)) {
      push(item.term); // 完整原文
      push(firstSurnameEtAl(item.term)); // 第一作者姓氏 + et al.
    } else if (item.term.includes('&')) {
      push(item.term); // 完整原文
      push(coAuthorSurnamesKey(item.term)); // 姓氏（保留 & 与逗号分隔）
    } else if (isSinglePersonName(item.term)) {
      push(item.term); // 完整姓名
      push(lastWord(item.term)); // 只认姓氏
    } else {
      push(item.term); // 机构：完整匹配
    }
  }

  return [...keys];
}

// 纵横填字专用：返回词条可作为「完整答案」填入格子的原始写法列表（统一为单数形式）。
// 术语含别名（斜杠/括号分隔），但一律转单数，避免随机到复数让学生对不上格子数。
export function getCrosswordAnswerForms(item: VocabItem): string[] {
  const forms = new Set<string>();
  const add = (s: string) => {
    const t = toSingularForm(s);
    if (t) forms.add(t);
  };
  if (item.type === 'term') {
    (TERM_ALIASES[item.term] ?? [item.term]).forEach(add);
  } else {
    // 学者：用完整原文（合著/缩写等复杂情况暂按原文整体作答）
    add(item.term);
  }
  return [...forms];
}

// 判断用户输入是否为某词条的正确答案
export function isCorrectAnswer(item: VocabItem, input: string): boolean {
  return getAcceptableKeys(item).includes(normalizeKey(input));
}

// ---- 提示脱敏：将答案（术语/学者名）在其自身释义上下文里替换为下划线 ----
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 学者姓氏（用于脱敏定义中出现的 "Beck (1992)..." 这类写法）；机构返回空
export function scholarSurnames(term: string): string[] {
  if (surnameOverrides()[term]) return [surnameOverrides()[term]];
  const clean = (seg: string) => lastWord(seg.replace(/\([^)]*\)/g, ' ').trim());
  if (/et\s+al/i.test(term)) {
    return [clean(term.split(/et\s+al/i)[0])];
  }
  if (/[&,]/.test(term)) {
    return term.split(/[&,]/).map(clean).filter(Boolean);
  }
  if (isSinglePersonName(term)) {
    return [clean(term)];
  }
  return [];
}

// 收集需要脱敏的"答案表面形式"（含别名、单复数变体、学者姓氏），长短语优先
function collectMaskForms(item: VocabItem): string[] {
  const forms = new Set<string>();
  const add = (s: string) => {
    const t = (s || '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').trim();
    if (t.length >= 2) forms.add(t);
  };

  if (item.type === 'term') {
    const list = TERM_ALIASES[item.term] ?? [item.term];
    list.forEach((base) => {
      add(base);
      singularPluralVariants(base).forEach(add);
    });
  } else {
    const list = SCHOLAR_ALIASES[item.term] ?? [item.term];
    list.forEach(add);
    scholarSurnames(item.term).forEach(add);
  }

  return [...forms].sort((a, b) => b.length - a.length);
}

// 将文本中出现的答案词替换为下划线（保留空格与标点），用于各题型展示释义提示
export function maskAnswer(item: VocabItem, text: string): string {
  if (!text) return text;
  let out = text;
  for (const form of collectMaskForms(item)) {
    const re = new RegExp(`\\b${escapeRegExp(form)}\\b`, 'gi');
    out = out.replace(re, (m) => m.replace(/[A-Za-z0-9]/g, '_'));
  }
  return out;
}

// 词典检索：返回词条所有可检索的原文片段（术语含别名与中文翻译；学者含别名、姓氏与理论流派）
export function getSearchableForms(item: VocabItem): string[] {
  const forms = new Set<string>();
  const add = (s?: string) => {
    const t = (s || '').trim();
    if (t) forms.add(t);
  };

  if (item.type === 'term') {
    add(item.term);
    (TERM_ALIASES[item.term] ?? []).forEach(add);
    add(item.chinese);
  } else {
    add(item.term);
    (SCHOLAR_ALIASES[item.term] ?? []).forEach(add);
    scholarSurnames(item.term).forEach(add);
    add(item.theory);
  }

  return [...forms];
}