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
  /** 逐日**练习** XP（只含起算日之后，见 `public.xp_start_date()`）。 */
  daily: { day_key: string; practice_xp: number }[];
  /** 逐日**奖励** XP（教师签发，按 Asia/Shanghai 归日）。
   *
   * ⚠ 为什么必须有这一份：学生端的「今日 / 本月 XP 增长」若只对 `daily` 求和，
   *   就会**漏掉教师签发的奖励**，而教师端榜单（`get_xp_summary_all`）是**含 bonus** 的
   *   （2026-09-29 教师裁定）⇒ 同一个「本月 XP 增长」会在两端显示成两个数。
   *   那是最容易被当成 bug 的一类不一致 —— 两边必须用同一个算法。 */
  bonus_daily: { day_key: string; bonus_xp: number }[];
}

/** get_xp_summary_all() 的单行返回（教师端批量，staff-only）。见 `db-migration-monthly.sql`。 */
export interface ClassXpRow {
  user_id: string;
  /** 累计练习 XP（起算日之后） */
  practice_all: number;
  /** 累计奖励 XP */
  bonus_all: number;
  /** practice_all + bonus_all，与 `get_xp_summary().total_xp` 同口径 */
  total_all: number;
  practice_range: number;
  bonus_range: number;
  /** 区间内 XP 增长（练习 + 奖励）—— 即「本月 XP 增长」，月度之星用它排序 */
  range_xp: number;
  /** 账号创建的**年月**（`'YYYY-MM'`，服务端已按 Asia/Shanghai 折算）。
   *
   * ⚠ 服务端给的是年月而不是时间戳：**时区折算必须只有一份**。前端若拿 UTC 时间戳
   *   `slice(0,7)`，在「月末最后几小时建号」时会差一个月（08-31 20:00 UTC = 09-01 04:00 上海），
   *   那个人就会被错判成"本月新加入"而失去参评资格（§4.5.3）。
   *  `null` = 取不到账号（理论上不会；`student_data` 里的人都应有 `auth.users` 行）。 */
  joined_month: string | null;
}

/** get_daily_study() 的返回（每日练习聚合，打卡判定用）。
 *
 * ⚠ 本类型的字段**必须与 `daily_study_of()` 的输出逐一对齐**（见该函数定义）：
 *   它把「基线 ∪ 事件 ∪ 补签」三源按 `day_key` 求和合并，字段含义如下。
 *   曾经漏过 `correct_full` / `makeup` 两个 —— 运行时数据里有、类型里没有，
 *   于是 TS 侧访问会报错，而被误以为「服务端没返回」。 */
export interface DailyStudy {
  day_key: string;
  /** 题数（只计 `kind='answer'`）。基线日为历史题数。 */
  questions: number;
  /** **毫秒**。⚠ 基线侧由「秒 × 1000」换算而来，事件侧本就是毫秒 —— 单位不统一会算错。 */
  ms: number;
  /** **score 累加**（不是答对数）：定义题 partial 记 0.5，与本地 `DayStudy.correct` 同口径。 */
  correct: number;
  /** 布尔全对计数。**基线日为 `null`**（历史数据没有这个维度，勿当 0）。 */
  correct_full: number | null;
  /** 该日是否有补签（补签日**直接算达标**，不看时长与题数）。 */
  makeup: boolean;
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

/** 教师端批量取数：全班每人的 XP（**staff-only**，服务端自查角色）。
 *  `from` / `to` 为 'YYYY-MM-DD'，省略即全量；月度之星传当月首末两天。 */
export async function fetchXpSummaryAll(from?: string, to?: string): Promise<ClassXpRow[]> {
  const { data, error } = await supabase.rpc('get_xp_summary_all', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) throw new Error(error.message || 'get_xp_summary_all failed');
  return (data ?? []) as ClassXpRow[];
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
