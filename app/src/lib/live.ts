// 课堂实时活动（拼写竞赛）数据层
//
// 服务端：db-migration-live-spell*.sql（表 + RPC）；全部口径见《实时多人在线功能规划.md》第七节。
// 铁律：
//   1) 判定与结算都在服务端 RPC 里完成，前端只发意图、只收结果 —— 前端永远不判对错。
//   2) 本轮术语（live_round_secrets）只对教师可读；学生端拿到的只有题干文本。
//   3) 时间一律用服务端时间：前端只做倒计时展示，不改判定。
import { supabase } from './supabase';
import type { VocabItem } from './types';
import { getAcceptableKeys, maskAnswer } from './answers';

// ---- 配置 ----
export interface LiveFilter {
  papers: string[];       // 出题范围：paper（空数组 = 全部）
  categories: string[];   // 出题范围：category
  units: string[];        // 出题范围：unit（空 = 不限）
  type: 'all' | 'term' | 'scholar';  // 术语 / 学者 / 综合
}

export interface LiveConfig {
  points_rank1: number;    // 第 1 名得分
  points_rank2: number;    // 第 2 名得分
  points_rank3: number;    // 第 3 名得分
  round_limit: number;     // 回合轮数上限（0 = 不限制；用于将来统计「通常几轮筛到剩 3 人」）
  buzz_window_ms: number;  // 抢答并列窗（毫秒）
  grace_seconds: number;   // 限时的服务端宽限（秒）
  filter?: LiveFilter;     // 出题范围（创建时选，随会话保存 —— 刷新/换设备后一致）
}

export const DEFAULT_LIVE_CONFIG: LiveConfig = {
  points_rank1: 3,
  points_rank2: 2,
  points_rank3: 1,
  round_limit: 0,
  buzz_window_ms: 1000,
  grace_seconds: 1,
  filter: { papers: [], categories: [], units: [], type: 'all' },
};

// ---- 行类型 ----
export interface LiveSession {
  id: string;
  kind: 'spell' | 'guess';
  class_id: string | null;
  host_id: string | null;
  title: string | null;
  state: string;
  config: Partial<LiveConfig> | null;
  join_code: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface LiveRound {
  id: string;
  session_id: string;
  group_no: number;
  round_no: number;
  stage: 'knockout' | 'buzz';
  prompt: string;
  state: 'open' | 'settled';
  deadline_at: string | null;
  answered_count: number;
  correct_count: number;
  first_correct_at: string | null;
  solved_users: string[] | null;
  settled_at: string | null;
  created_at: string;
}

export interface LiveStateRow {
  id: string;
  session_id: string;
  group_no: number;
  user_id: string;
  name: string | null;
  out_round_no: number | null;
  survived_rounds: number;
  points: number;
  rank_in_group: number | null;
  updated_at: string;
}

export interface LiveParticipant {
  id: string;
  session_id: string;
  user_id: string;
  name: string | null;
  joined_at: string;
  last_seen: string;
}

// ---- 会话 ----
export async function fetchRunningSession(): Promise<LiveSession | null> {
  const { data, error } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('state', 'running')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as LiveSession) ?? null;
}

// 历史场次（最近 N 场）：教师看全部，学生用来回看自己的成绩
export async function fetchRecentSessions(limit = 10): Promise<LiveSession[]> {
  const { data, error } = await supabase
    .from('live_sessions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as LiveSession[];
}

export async function fetchSession(id: string): Promise<LiveSession | null> {
  const { data, error } = await supabase.from('live_sessions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as LiveSession) ?? null;
}

export async function createSession(
  hostId: string,
  kind: 'spell' | 'guess',
  title: string,
  config: Partial<LiveConfig> = {},
): Promise<LiveSession> {
  const { data, error } = await supabase
    .from('live_sessions')
    .insert({ kind, title, host_id: hostId, state: 'running', config: { ...DEFAULT_LIVE_CONFIG, ...config } })
    .select()
    .single();
  if (error) throw error;
  return data as LiveSession;
}

export async function closeSession(id: string): Promise<void> {
  const { error } = await supabase
    .from('live_sessions')
    .update({ state: 'closed', closed_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// 加入（当前 join_code 为空 = 一键加入；将来填了密码就传 p_code）
export async function joinSession(
  sessionId: string,
  code?: string,
): Promise<{ participant_id: string; session_id: string; kind: string }> {
  const { data, error } = await supabase.rpc('live_join_session', {
    p_session_id: sessionId,
    p_code: code ?? null,
  });
  if (error) throw error;
  return data as { participant_id: string; session_id: string; kind: string };
}

export async function fetchParticipants(sessionId: string): Promise<LiveParticipant[]> {
  const { data, error } = await supabase
    .from('live_participants')
    .select('*')
    .eq('session_id', sessionId)
    .order('joined_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as LiveParticipant[];
}

// ---- 回合与轮次 ----
export async function startGroup(sessionId: string, groupNo: number): Promise<number> {
  const { data, error } = await supabase.rpc('live_start_group', {
    p_session_id: sessionId,
    p_group_no: groupNo,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function openRound(args: {
  sessionId: string;
  groupNo: number;
  roundNo: number;
  stage: 'knockout' | 'buzz';
  prompt: string;
  termId: string;
  seconds: number;
}): Promise<string> {
  const { data, error } = await supabase.rpc('live_open_round', {
    p_session_id: args.sessionId,
    p_group_no: args.groupNo,
    p_round_no: args.roundNo,
    p_stage: args.stage,
    p_prompt: args.prompt,
    p_term_id: args.termId,
    p_seconds: args.seconds,
  });
  if (error) throw error;
  return data as string;
}

export async function submitAnswer(
  roundId: string,
  text: string,
  graceSeconds = 1,
): Promise<{ is_correct: boolean; already: boolean; reason: string }> {
  const { data, error } = await supabase.rpc('live_submit_answer', {
    p_round_id: roundId,
    p_text: text,
    p_grace_seconds: graceSeconds,
  });
  if (error) throw error;
  return data as { is_correct: boolean; already: boolean; reason: string };
}

export interface LiveSettleResult {
  already?: boolean;
  stage?: string;
  alive_before?: number;
  alive_after?: number;
  winners?: string[];
  group_finished?: boolean;
}

export async function settleRound(roundId: string, buzzWindowMs = 1000): Promise<LiveSettleResult> {
  const { data, error } = await supabase.rpc('live_settle_round', {
    p_round_id: roundId,
    p_buzz_window_ms: buzzWindowMs,
  });
  if (error) throw error;
  return data as LiveSettleResult;
}

export async function fetchRound(id: string): Promise<LiveRound | null> {
  const { data, error } = await supabase.from('live_spell_rounds').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as LiveRound) ?? null;
}

// 当前应该显示的那一轮：最新创建的一轮
export async function fetchLatestRound(sessionId: string): Promise<LiveRound | null> {
  const { data, error } = await supabase
    .from('live_spell_rounds')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as LiveRound) ?? null;
}

export async function fetchGroupRounds(sessionId: string, groupNo: number): Promise<LiveRound[]> {
  const { data, error } = await supabase
    .from('live_spell_rounds')
    .select('*')
    .eq('session_id', sessionId)
    .eq('group_no', groupNo)
    .order('round_no', { ascending: true });
  if (error) throw error;
  return (data ?? []) as LiveRound[];
}

// ---- 存亡与积分 ----
export async function fetchGroupState(sessionId: string, groupNo: number): Promise<LiveStateRow[]> {
  const { data, error } = await supabase
    .from('live_spell_state')
    .select('*')
    .eq('session_id', sessionId)
    .eq('group_no', groupNo)
    .order('user_id', { ascending: true });
  if (error) throw error;
  return (data ?? []) as LiveStateRow[];
}

// 整节课的状态行（跨回合）；总积分榜在前端按 user_id 汇总 points
export async function fetchSessionState(sessionId: string): Promise<LiveStateRow[]> {
  const { data, error } = await supabase
    .from('live_spell_state')
    .select('*')
    .eq('session_id', sessionId);
  if (error) throw error;
  return (data ?? []) as LiveStateRow[];
}

// 断线重连：拉自己在该轮的提交（只认第一条，所以有行就代表已作答过）
export async function fetchMyAnswer(
  roundId: string,
  userId: string,
): Promise<{ text: string; is_correct: boolean; created_at: string } | null> {
  const { data, error } = await supabase
    .from('live_spell_answers')
    .select('text, is_correct, created_at')
    .eq('round_id', roundId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as { text: string; is_correct: boolean; created_at: string }) ?? null;
}

// 本场已经出过的词（教师端用）：跨回合共享「已出池」，避免同一节课重复出题、也避免把某一难度档抽干
export async function fetchUsedTermIds(sessionId: string): Promise<Set<string>> {
  const { data: rounds, error } = await supabase.from('live_spell_rounds').select('id').eq('session_id', sessionId);
  if (error) throw error;
  const ids = (rounds ?? []).map((r) => (r as { id: string }).id);
  if (ids.length === 0) return new Set<string>();
  const { data: secrets, error: e2 } = await supabase.from('live_round_secrets').select('term_id').in('round_id', ids);
  if (e2) throw e2;
  return new Set((secrets ?? []).map((s) => (s as { term_id: string }).term_id));
}

// 本轮术语原文：**只有轮次结算之后才读得到**（RLS 策略：secrets 仅教师可读 + 轮次 settled 后全班可读）。
// 轮次进行中调用会静默返回 null —— 这正是「本轮结束前不公布答案」的实现方式。
export async function fetchRoundTerm(roundId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('live_round_secrets')
    .select('term_id')
    .eq('round_id', roundId)
    .maybeSingle();
  if (error) return null;
  return (data as { term_id: string } | null)?.term_id ?? null;
}

// ---- 实时订阅（只推信号；收到后由调用方决定拉取什么）----
export interface LiveSignal {
  table: 'live_events' | 'live_spell_rounds' | 'live_spell_state' | 'live_participants';
  type: string;
  row: Record<string, unknown>;
}

export function subscribeLive(sessionId: string, onSignal: (s: LiveSignal) => void): () => void {
  const filter = `session_id=eq.${sessionId}`;
  const channel = supabase
    .channel(`live:${sessionId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_events', filter }, (p) =>
      onSignal({ table: 'live_events', type: p.eventType, row: (p.new ?? {}) as Record<string, unknown> }),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_spell_rounds', filter }, (p) =>
      onSignal({ table: 'live_spell_rounds', type: p.eventType, row: (p.new ?? {}) as Record<string, unknown> }),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_spell_state', filter }, (p) =>
      onSignal({ table: 'live_spell_state', type: p.eventType, row: (p.new ?? {}) as Record<string, unknown> }),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_participants', filter }, (p) =>
      onSignal({ table: 'live_participants', type: p.eventType, row: (p.new ?? {}) as Record<string, unknown> }),
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

// ---- 抽题：难度递增 ----
// 难度代理 = 「最短可接受写法」的归一化字母数（见文档第七节「难度递增」）。
// 注意不是 term 字面：`Intelligence Quotient (IQ)` 按可接受写法是 `iq`（2），按字面是 22。
export function difficultyOf(item: VocabItem): number {
  const keys = getAcceptableKeys(item);
  if (keys.length === 0) return 0;
  let min = Number.MAX_SAFE_INTEGER;
  for (const k of keys) if (k.length < min) min = k.length;
  return min === Number.MAX_SAFE_INTEGER ? 0 : min;
}

// 题干：固定用「脱敏英文释义」（不用中文 —— 词典页检索得到中文，等于给反查入口）
export function spellPrompt(item: VocabItem): string {
  return maskAnswer(item, item.definition || item.term);
}

// 按目标难度分位抽一个词：percentile 0 = 池中最易，1 = 最难。
// usedTermIds 是「本场已出过的词」——跨回合共享，避免重复与把某一档抽干。
export function pickRoundTerm(
  pool: VocabItem[],
  usedTermIds: Set<string>,
  percentile: number,
): VocabItem | null {
  const avail = pool.filter((i) => !usedTermIds.has(i.id) && i.definition && i.term);
  if (avail.length === 0) return null;
  const sorted = [...avail].sort((a, b) => difficultyOf(a) - difficultyOf(b));
  const target = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * percentile)));
  // 在目标位置附近取一个小窗口随机，避免同一分位每次都抽到同一个词
  const lo = Math.max(0, target - 3);
  const hi = Math.min(sorted.length - 1, target + 3);
  return sorted[lo + Math.floor(Math.random() * (hi - lo + 1))];
}

// 淘汰段第 n 轮的难度分位：从 0.15 线性升到 0.85（保证后期有人被淘汰）
export function knockoutPercentile(roundNo: number, softCap = 10): number {
  const t = Math.min(1, Math.max(0, (roundNo - 1) / Math.max(1, softCap - 1)));
  return 0.15 + t * 0.7;
}

// 抢答段的难度分位：中等偏上（太难会让三人全错、回合僵住）
export const BUZZ_PERCENTILE = 0.65;
