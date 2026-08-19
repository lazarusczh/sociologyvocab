import type { VocabItem, Progress, ContextPassage } from './types';

const VOCAB_KEY = 'socio_vocab_items';
const PROGRESS_KEY = 'socio_vocab_progress';
const CONTEXT_KEY = 'socio_vocab_contexts';
const CONFIG_KEY = 'socio_vocab_configured';

// ---- 词库 ----
export function loadVocab(): VocabItem[] {
  try {
    const raw = localStorage.getItem(VOCAB_KEY);
    return raw ? (JSON.parse(raw) as VocabItem[]) : [];
  } catch {
    return [];
  }
}

export function saveVocab(items: VocabItem[]): void {
  localStorage.setItem(VOCAB_KEY, JSON.stringify(items));
}

export function clearVocab(): void {
  localStorage.removeItem(VOCAB_KEY);
}

// 是否已由用户配置过词库（导入或清空过），避免每次刷新都重新加载内置词库覆盖
export function isConfigured(): boolean {
  return localStorage.getItem(CONFIG_KEY) === '1';
}

export function setConfigured(): void {
  localStorage.setItem(CONFIG_KEY, '1');
}

// ---- 进度 ----
export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as Progress) : {};
  } catch {
    return {};
  }
}

export function saveProgress(progress: Progress): void {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

// 记录一次练习结果
export function recordAnswer(
  itemId: string,
  correct: boolean,
  progress: Progress,
): Progress {
  const cur = progress[itemId] || { mastery: 0, seenCount: 0, correctCount: 0, lastSeen: 0 };
  const next = {
    ...cur,
    seenCount: cur.seenCount + 1,
    correctCount: cur.correctCount + (correct ? 1 : 0),
    lastSeen: Date.now(),
  };
  // 自动调整掌握度：连续答对提升，答错降低
  const rate = next.correctCount / next.seenCount;
  if (next.seenCount >= 3 && rate >= 0.8) next.mastery = Math.max(next.mastery, 2);
  if (next.seenCount >= 5 && rate >= 0.9) next.mastery = 3;
  if (rate < 0.5 && next.seenCount >= 2) next.mastery = Math.min(next.mastery, 1);
  return { ...progress, [itemId]: next };
}

// 手动设置掌握度（闪卡用）
export function setMastery(
  itemId: string,
  mastery: number,
  progress: Progress,
): Progress {
  const cur = progress[itemId] || { mastery: 0, seenCount: 0, correctCount: 0, lastSeen: 0 };
  return {
    ...progress,
    [itemId]: { ...cur, mastery, lastSeen: Date.now() },
  };
}

// ---- 范文语境 ----
export function loadContexts(): ContextPassage[] {
  try {
    const raw = localStorage.getItem(CONTEXT_KEY);
    return raw ? (JSON.parse(raw) as ContextPassage[]) : [];
  } catch {
    return [];
  }
}

export function saveContexts(contexts: ContextPassage[]): void {
  localStorage.setItem(CONTEXT_KEY, JSON.stringify(contexts));
}
