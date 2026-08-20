import type { VocabItem, Progress, ContextPassage, CheckInState, WrongBook, PracticeMode, SurnameOverrides } from './types';
import { emptyCheckIn } from './checkin';

// 掌握度四档标签（界面展示用）
export const MASTERY_LABELS = ['未学', '不熟', '熟悉', '掌握'] as const;

// 考卷大类顺序（对应 9699A Level 社会学大纲四张考卷）
export const PAPER_ORDER = ['Paper 1', 'Paper 2', 'Paper 3', 'Paper 4'] as const;

// 掌握度数值 → 四档（0=未学 1=不熟 2=熟悉 3=掌握）
export function masteryLevel(mastery: number): number {
  if (mastery <= 0) return 0;
  if (mastery <= 40) return 1;
  if (mastery <= 70) return 2;
  return 3;
}

// 不同练习模式的掌握度增减权重（拼写最高、配对居中、选择最低；扣分 > 加分，防止靠蒙虚高）
const MASTERY_WEIGHTS: Record<PracticeMode, { gain: number; loss: number }> = {
  choice: { gain: 6, loss: 12 },
  matching: { gain: 8, loss: 16 },
  spelling: { gain: 12, loss: 24 },
};

// 依据答对/答错动态调整掌握度（0-100 区间）
export function adjustMastery(mastery: number, correct: boolean, mode: PracticeMode): number {
  const { gain, loss } = MASTERY_WEIGHTS[mode];
  const next = correct ? mastery + gain : mastery - loss;
  return Math.max(0, Math.min(100, next));
}

const VOCAB_KEY = 'socio_vocab_items';
const PROGRESS_KEY = 'socio_vocab_progress';
const CONTEXT_KEY = 'socio_vocab_contexts';
const CONFIG_KEY = 'socio_vocab_configured';
const CHECKIN_KEY = 'socio_vocab_checkin';
const WRONG_KEY = 'socio_vocab_wrong';
const SURNAME_OVERRIDES_KEY = 'socio_vocab_surname_overrides';

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

// 记录一次练习结果（含按模式权重的掌握度动态调整）
export function recordAnswer(
  itemId: string,
  correct: boolean,
  mode: PracticeMode,
  progress: Progress,
): Progress {
  const cur = progress[itemId] || { mastery: 0, seenCount: 0, correctCount: 0, lastSeen: 0 };
  const next = {
    ...cur,
    seenCount: cur.seenCount + 1,
    correctCount: cur.correctCount + (correct ? 1 : 0),
    lastSeen: Date.now(),
    mastery: adjustMastery(cur.mastery, correct, mode),
  };
  return { ...progress, [itemId]: next };
}

// 掌握度模型 v2 一次性迁移：旧版掌握度为离散档位（0-3），语义与新的 0-100 连续值不同，
// 直接重置为 0，保留练习次数等统计。
export function resetMastery(progress: Progress): Progress {
  const next: Progress = {};
  for (const [id, p] of Object.entries(progress)) {
    next[id] = { ...p, mastery: 0 };
  }
  return next;
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

// ---- 打卡 ----
export function loadCheckIn(): CheckInState {
  try {
    const raw = localStorage.getItem(CHECKIN_KEY);
    if (!raw) return emptyCheckIn();
    const parsed = JSON.parse(raw) as CheckInState;
    // 兼容旧数据：确保必要字段存在
    return {
      study: parsed.study || {},
      makeup: parsed.makeup || {},
      earnedMakeupWeeks: parsed.earnedMakeupWeeks || [],
      bestStreak: parsed.bestStreak || 0,
    };
  } catch {
    return emptyCheckIn();
  }
}

export function saveCheckIn(state: CheckInState): void {
  localStorage.setItem(CHECKIN_KEY, JSON.stringify(state));
}

// ---- 错题 ----
export function loadWrongBook(): WrongBook {
  try {
    const raw = localStorage.getItem(WRONG_KEY);
    return raw ? (JSON.parse(raw) as WrongBook) : {};
  } catch {
    return {};
  }
}

export function saveWrongBook(book: WrongBook): void {
  localStorage.setItem(WRONG_KEY, JSON.stringify(book));
}

// ---- 特殊姓氏覆盖表（用户人工指定非常规学者名的「姓氏」处理方式）----
export function loadSurnameOverrides(): SurnameOverrides {
  try {
    const raw = localStorage.getItem(SURNAME_OVERRIDES_KEY);
    return raw ? (JSON.parse(raw) as SurnameOverrides) : {};
  } catch {
    return {};
  }
}

export function saveSurnameOverrides(overrides: SurnameOverrides): void {
  localStorage.setItem(SURNAME_OVERRIDES_KEY, JSON.stringify(overrides));
}
