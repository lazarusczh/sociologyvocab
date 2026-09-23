// XP 体系（C 档）客户端入口：事件构造 + 上报 + 读取出口 + 等级换算。
//
// 设计要点（详见《XP-C档改造方案.md》与 db-migration-xp-c.sql）：
//
//   · **服务端是唯一算分方**。客户端只上报「事实」（做了哪题、对不对、花了多久），
//     **绝不上报 XP 数值** —— 分值由服务端的 xp_of() 查表得出。
//     好处：以后调分值只改一个 SQL 常量，**不必发前端版本**，也不会出现新旧客户端
//     算出不同分数的口径分叉。
//
//   · **event_id 由客户端生成**（UUID），它是幂等键。离线补报、失败重试、重复提交
//     全指望它去重；服务端把重复的记为 duplicated（不二次计分）。
//
//   · 上报失败**不抛给练习流程** —— 练习体验优先。失败的事件留在本地队列待补报
//     （见 ./xpQueue.ts）。

import { supabase } from './supabase';
import type { PracticeMode } from './types';

// ---------- 类型（字段名必须与 db-migration-xp-c.sql 的 jsonb_to_recordset 一致）----------

export type XpKind = 'answer' | 'chain_complete';
export type ChainMode = 'open' | 'target';
export type ChainKind = 'choice' | 'input';

/** 一条待上报的 XP 事件。**字段名服务端按名取值，改名前先改 SQL。** */
export interface XpEvent {
  event_id: string;
  kind: XpKind;
  item_id: string;
  mode: PracticeMode;
  correct: boolean;
  score: number;
  elapsed_ms?: number | null;
  answered_at: string;
  session_id?: string | null;
  chain_mode?: ChainMode | null;
  chain_kind?: ChainKind | null;
}

/** 服务端拒收的原因（见 submit_xp_events 的各个 continue 分支）。 */
export type XpRejectReason =
  | 'missing_field'
  | 'future_time'
  | 'too_old'
  | 'settled_month'
  | 'bad_mode'
  | 'bad_kind'
  | 'same_item_too_soon';

export interface XpRejection {
  event_id?: string | null;
  reason: XpRejectReason | string;
}

export interface XpSubmitResult {
  accepted: number;
  duplicated: number;
  rejected: XpRejection[];
}

/** get_xp_summary() 的返回。练习 XP 与奖励 XP **现算相加，永不落盘**。 */
export interface XpSummary {
  practice_xp: number;
  bonus_xp: number;
  total_xp: number;
  daily: { day_key: string; practice_xp: number }[];
}

/** get_daily_study() 的返回（每日练习聚合，打卡判定用）。 */
export interface DailyStudy {
  day_key: string;
  questions: number;
  ms: number;
  correct: number;
}

// ---------- 事件构造 ----------

/** 生成幂等键。优先 crypto.randomUUID（现代浏览器与 WebView 均有）。 */
export function newEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 兜底：极老环境没有 randomUUID，用 getRandomValues 手拼一个 v4
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 单题作答事件（recordItem 的产物）。
 *
 * elapsedMs **尽量给**（定义题等已知耗时的题型务必给）：
 * 它既是每日时长的来源，也是服务端判定「异常刷分」的依据。
 * 给不出就传 null —— 服务端会把这题的时长记为 NULL（不参与时长累计），
 * 但**事件仍然收下、XP 照给**（不因缺用时扣分）。
 */
export function buildAnswerEvent(p: {
  itemId: string;
  mode: PracticeMode;
  correct: boolean;
  score: number;
  elapsedMs?: number | null;
  sessionId?: string | null;
  at?: Date;
}): XpEvent {
  return {
    event_id: newEventId(),
    kind: 'answer',
    item_id: p.itemId,
    mode: p.mode,
    correct: p.correct,
    score: p.score,
    elapsed_ms: p.elapsedMs ?? null,
    answered_at: (p.at ?? new Date()).toISOString(),
    session_id: p.sessionId ?? null,
  };
}

/**
 * 接龙「完成」事件。**只有走完整条线才发**（见方案 §2.1.1）。
 *
 * ⚠ 接龙的每一步**不走这里** —— 每步仍要 recordItem（掌握度 / 题数 / 错题本），
 *   但**不发 XP**；分值只在完成时结算一次，因此「回退刷分」与「绕远刷分」两个
 *   漏洞自动失效。sessionId 由服务端的部分唯一索引保证一局只结算一次。
 *
 * 分值取决于「路线 + 作答方式」，由服务端按 chain_mode / chain_kind 查表，
 * **客户端不得指定 XP**；correct / score 对 chain_complete 无语义（仅为满足 NOT NULL）。
 */
export function buildChainCompleteEvent(p: {
  itemId: string;
  sessionId: string;
  chainMode: ChainMode;
  chainKind: ChainKind;
  at?: Date;
}): XpEvent {
  return {
    event_id: newEventId(),
    kind: 'chain_complete',
    item_id: p.itemId,
    mode: 'chain',
    correct: true,
    score: 1,
    elapsed_ms: null,
    answered_at: (p.at ?? new Date()).toISOString(),
    session_id: p.sessionId,
    chain_mode: p.chainMode,
    chain_kind: p.chainKind,
  };
}

// ---------- 上报与读取 ----------

/** 服务端单次上报上限（对应 submit_xp_events 的 `v_n > 100` 断言）。 */
export const SUBMIT_BATCH_MAX = 100;

/**
 * 上报一批事件。
 * ⚠ **调用方负责分批**：一次超过 SUBMIT_BATCH_MAX 会被服务端整个拒绝（不是截断）。
 * 网络层失败会**抛错**（由队列决定重试）；业务性拒绝在返回值 rejected 里。
 */
export async function submitXpEvents(events: XpEvent[]): Promise<XpSubmitResult> {
  if (events.length === 0) return { accepted: 0, duplicated: 0, rejected: [] };
  if (events.length > SUBMIT_BATCH_MAX) {
    throw new Error(`too many events in one call (max ${SUBMIT_BATCH_MAX})`);
  }
  const { data, error } = await supabase.rpc('submit_xp_events', { p_events: events });
  if (error) throw new Error(error.message || 'submit_xp_events failed');
  return data as XpSubmitResult;
}

/** 总 XP。省略 userId 即查自己；教师/开发者可传他人，学生传他人会被服务端拒绝。 */
export async function fetchXpSummary(userId?: string): Promise<XpSummary> {
  const { data, error } = await supabase.rpc('get_xp_summary', { p_user_id: userId ?? null });
  if (error) throw new Error(error.message || 'get_xp_summary failed');
  return data as XpSummary;
}

/** 每日练习聚合（打卡判定用）。from / to 为 'YYYY-MM-DD'。 */
export async function fetchDailyStudy(
  userId?: string,
  from?: string,
  to?: string,
): Promise<DailyStudy[]> {
  const { data, error } = await supabase.rpc('get_daily_study', {
    p_user_id: userId ?? null,
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) throw new Error(error.message || 'get_daily_study failed');
  return (data ?? []) as DailyStudy[];
}

// ---------- 等级换算 ----------
// 曲线本身是**纯计算**，拆到 ./xpLevel.ts（不依赖网络，可独立测试与复用）；
// 这里原样再导出，调用方只需 import './xp' 一处。
export * from './xpLevel';
