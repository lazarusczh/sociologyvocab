// 打卡与错题收集的纯逻辑（不涉及 localStorage，便于测试与复用）
import type { CheckInState, DayStudy, WrongBook, WrongEntry } from './types';

// ---- 规则常量 ----
export const CHECKIN_DAY_GOAL_SECONDS = 10 * 60; // 每日打卡所需学习秒数（10 分钟）
export const CHECKIN_DAY_GOAL_QUESTIONS = 20;    // 每日打卡所需正式练习题数
export const MAKEUP_WEEK_QUESTIONS = 100;        // 触发补签的一周练习题数
export const MAKEUP_WEEK_ACCURACY = 0.8;         // 触发补签的一周正确率（80%）
export const WRONG_ENTER_THRESHOLD = 2;          // 累计答错 N 次进入错题本
export const WRONG_EXIT_CONSECUTIVE = 3;         // 连续答对 N 次移出错题本

// ---- 日期工具（本地时区，dateKey 形如 YYYY-MM-DD）----
export function dateKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayKey(): string {
  return dateKeyOf(new Date());
}

// 固定在 0 点的日期，避免跨天/时区漂移
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function parseKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// 周起始（周一）
export function weekStartKey(d: Date): string {
  const day = startOfDay(d).getDay(); // 0=周日 … 6=周六
  const diff = day === 0 ? -6 : 1 - day;
  return dateKeyOf(addDays(d, diff));
}

// ---- 打卡状态 ----
export function emptyCheckIn(): CheckInState {
  return { study: {}, makeup: {}, earnedMakeupWeeks: [], bestStreak: 0 };
}

// 某天是否已完成打卡（含补签）
export function isDayChecked(state: CheckInState, key: string): boolean {
  if (state.makeup[key]) return true;
  const s = state.study[key];
  return !!s && s.seconds >= CHECKIN_DAY_GOAL_SECONDS && s.questions >= CHECKIN_DAY_GOAL_QUESTIONS;
}

// 计算当前连续天数（今天未打卡但昨天已打卡时，今天视为“待完成”，连续不中断）
export function computeStreak(state: CheckInState, now: Date = new Date()): number {
  let cursor = now;
  if (!isDayChecked(state, dateKeyOf(cursor))) {
    cursor = addDays(cursor, -1);
  }
  let streak = 0;
  while (isDayChecked(state, dateKeyOf(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// 记录一次正式练习（选择题/拼写/匹配/错题练习），更新当日题数与答对数
export function recordFormalAnswer(state: CheckInState, correct: boolean, now: Date = new Date()): CheckInState {
  const key = dateKeyOf(now);
  const cur: DayStudy = state.study[key] || { seconds: 0, questions: 0, correct: 0 };
  const next: CheckInState = {
    ...state,
    study: {
      ...state.study,
      [key]: { seconds: cur.seconds, questions: cur.questions + 1, correct: cur.correct + (correct ? 1 : 0) },
    },
  };
  next.bestStreak = Math.max(next.bestStreak, computeStreak(next, now));
  return next;
}

// 累加学习秒数（由计时器调用，只更新时间，不改题数）
export function addStudySeconds(state: CheckInState, seconds: number, now: Date = new Date()): CheckInState {
  const key = dateKeyOf(now);
  const cur: DayStudy = state.study[key] || { seconds: 0, questions: 0, correct: 0 };
  return {
    ...state,
    study: {
      ...state.study,
      [key]: { ...cur, seconds: cur.seconds + seconds },
    },
  };
}

// 本周（周一至周日）正式练习累计题数与答对数
export function weeklyStats(state: CheckInState, now: Date = new Date()) {
  const ws = weekStartKey(now);
  let questions = 0;
  let correct = 0;
  for (let i = 0; i < 7; i++) {
    const s = state.study[dateKeyOf(addDays(parseKey(ws), i))];
    if (s) {
      questions += s.questions;
      correct += s.correct;
    }
  }
  return { weekStartKey: ws, questions, correct };
}

// 本周是否满足补签触发条件（题数≥100 且正确率≥80%，且本周尚未获得过）
export function canEarnMakeup(state: CheckInState, now: Date = new Date()): boolean {
  const { weekStartKey: wk, questions, correct } = weeklyStats(state, now);
  if (questions < MAKEUP_WEEK_QUESTIONS) return false;
  if (correct / questions < MAKEUP_WEEK_ACCURACY) return false;
  if (state.earnedMakeupWeeks.includes(wk)) return false;
  return true;
}

// 本周内尚未打卡且已过去（不含今天）的日期（可补签的候选）
export function missedDaysInWeek(state: CheckInState, now: Date = new Date()): string[] {
  const ws = parseKey(weekStartKey(now));
  const today = parseKey(dateKeyOf(now));
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    if (d.getTime() >= today.getTime()) break; // 只补今天之前的日子
    const k = dateKeyOf(d);
    if (!isDayChecked(state, k)) out.push(k);
  }
  return out;
}

// 补签某天（仅在满足触发条件且目标天为本周漏签日时生效）
export function applyMakeup(state: CheckInState, dayKey: string, now: Date = new Date()): CheckInState {
  if (!canEarnMakeup(state, now)) return state;
  if (!missedDaysInWeek(state, now).includes(dayKey)) return state;
  const next: CheckInState = {
    ...state,
    makeup: { ...state.makeup, [dayKey]: true },
    earnedMakeupWeeks: [...state.earnedMakeupWeeks, weekStartKey(now)],
  };
  next.bestStreak = Math.max(next.bestStreak, computeStreak(next, now));
  return next;
}

// ---- 错题收集 ----
export function applyWrongAnswer(book: WrongBook, itemId: string, correct: boolean): WrongBook {
  const cur: WrongEntry = book[itemId] || { wrongCount: 0, consecutiveCorrect: 0 };
  const next: WrongEntry = correct
    ? { wrongCount: cur.wrongCount, consecutiveCorrect: cur.consecutiveCorrect + 1 }
    : { wrongCount: cur.wrongCount + 1, consecutiveCorrect: 0 };
  return { ...book, [itemId]: next };
}

// 是否在错题本中（累计答错≥2 且尚未连续答对满 3 次）
export function isInWrongBook(entry: WrongEntry | undefined): boolean {
  if (!entry) return false;
  return entry.wrongCount >= WRONG_ENTER_THRESHOLD && entry.consecutiveCorrect < WRONG_EXIT_CONSECUTIVE;
}