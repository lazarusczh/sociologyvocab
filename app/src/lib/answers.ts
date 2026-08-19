// 答案判定与容错逻辑
import type { VocabItem } from './types';

// 归一化：忽略大小写、空格、连字符、标点、重音等，只保留小写字母与数字
export function normalizeKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // 去变音符号（é->e, ü->u …）
    .toLowerCase()
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
  'News values / newsworthiness': ['News values', 'newsworthiness'],
};

// 学者/机构名（含括号、缩写、来源说明等）的等价写法
const SCHOLAR_ALIASES: Record<string, string[]> = {
  '(Gloria Jean Watkins) bell hooks': ['bell hooks', 'hooks'],
  'Ulrich Beck (& Elisabeth Beck-Gernsheim)': ['Ulrich Beck', 'Beck'],
  'Michael (Dunlop) Young': ['Michael Young', 'Young'],
  'America Sociology Association (ASA)': ['America Sociology Association', 'ASA'],
  'America Psychology Association (APA)': ['America Psychology Association', 'APA'],
  'Centre for the Modern Family (quoted by Daily Mail)': ['Centre for the Modern Family'],
  'RIAS (Ageas), a British insurance company': ['RIAS'],
  'Glasgow University Media Group (GUMG)': ['Glasgow University Media Group', 'GUMG'],
};

// 机构/来源特征词：命中则视为非人名，不套用"只认姓氏"
const ORG_KEYWORDS = [
  'association', 'centre', 'center', 'government', 'bank', 'court', 'commission',
  'service', 'survey', 'research', 'institute', 'university', 'resource', 'group',
  'congress', 'council', 'national', 'world',
];

function lastWord(s: string): string {
  const words = s.trim().split(/\s+/);
  return words[words.length - 1] || '';
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

// 获取某词条所有可接受写法的归一化键集合
export function getAcceptableKeys(item: VocabItem): string[] {
  const keys = new Set<string>();
  const push = (s: string) => {
    const k = normalizeKey(s);
    if (k) keys.add(k);
  };

  if (item.type === 'term') {
    const list = TERM_ALIASES[item.term] ?? [item.term];
    list.forEach(push);
  } else {
    if (SCHOLAR_ALIASES[item.term]) {
      SCHOLAR_ALIASES[item.term].forEach(push);
    } else if (isSinglePersonName(item.term)) {
      push(item.term); // 完整姓名
      push(lastWord(item.term)); // 只认姓氏
    } else {
      push(item.term); // 机构 / 合著 / et al.：完整匹配
    }
  }

  return [...keys];
}

// 判断用户输入是否为某词条的正确答案
export function isCorrectAnswer(item: VocabItem, input: string): boolean {
  return getAcceptableKeys(item).includes(normalizeKey(input));
}