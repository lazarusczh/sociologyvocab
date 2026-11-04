// 模拟调研（课堂活动 kind='sim'）数据层
//
// 口径：
//   · 阶段在 live_sessions.config.phase：lobby → grouped → frozen → answered → reveal
//   · 判定/校验全在服务端 RPC；前端只发意图、只做格式提示
//   · 实时只当信号：收到变更后重拉权威数据
//   · 人设卡与内心（sim_personas / sim_persona_inner）只有教师读得到，
//     前端不得把卡片内容写进常量（dist 是公开的）
import { supabase } from './supabase';

export type SimPhase = 'lobby' | 'grouped' | 'frozen' | 'answered' | 'reveal';
export type SimQType = 'single' | 'multi' | 'scale';

export interface SimOption {
  key: string;
  label: string;
}

export interface SimSession {
  id: string;
  kind: string;
  host_id: string | null;
  title: string | null;
  state: string;
  config: {
    phase?: SimPhase;
    targetGroupSize?: number;
    perGroupLimit?: number;
    pack?: string;
  } | null;
  created_at: string;
  closed_at: string | null;
}

export interface SimGroup {
  id: string;
  session_id: string;
  group_no: number;
}

export interface SimQuestion {
  id: string;
  session_id: string;
  group_id: string;
  author_id: string;
  qtype: SimQType;
  stem: string;
  options: SimOption[];
  position: number;
  created_at: string;
  updated_at: string;
}

export interface SimParticipant {
  id: string;
  session_id: string;
  user_id: string;
  name: string | null;
  group_id: string | null;
  joined_at: string;
  last_seen: string;
}

export interface SimPaper {
  id: string;
  session_id: string;
  version: number;
  items: SimPaperItem[];
  frozen_at: string;
}

export interface SimPaperItem {
  qid: string;
  qtype: SimQType;
  stem: string;
  options: SimOption[];
  source_group?: number;
  edited_by_teacher?: boolean;
}

export interface SimAnswerRow {
  session_id: string;
  paper_version: number;
  persona_id: string;
  answers: { qid: string; value?: unknown; skipped?: boolean }[];
}

export interface SimPersona {
  id: string;
  pack: string;
  order_no: number;
  name: string;
  card: {
    key?: string;
    who?: string;
    scene?: string;
    facts?: string;
    voice?: string;
    surface?: string;
    inner?: string;
    extra?: string;
  };
}

export interface SimReveal {
  session_id: string;
  qid: string;
  stage: 'answers' | 'inner';
  revealed_at: string;
}

export const phaseOf = (s: SimSession | null): SimPhase =>
  (s?.config?.phase as SimPhase) ?? 'lobby';

export const groupLimitOf = (s: SimSession | null): number =>
  Math.max(1, Math.min(10, s?.config?.perGroupLimit ?? 3));

export const targetSizeOf = (s: SimSession | null): number =>
  Math.max(2, Math.min(10, s?.config?.targetGroupSize ?? 5));

// ---- 会话 ----

export async function fetchRunningSimSession(): Promise<SimSession | null> {
  const { data, error } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('state', 'running')
    .eq('kind', 'sim')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as SimSession) ?? null;
}

export async function fetchSimSession(id: string): Promise<SimSession | null> {
  const { data, error } = await supabase.from('live_sessions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as SimSession) ?? null;
}

export async function createSimSession(
  hostId: string,
  title: string,
  opts: { targetGroupSize?: number; perGroupLimit?: number; pack?: string } = {},
): Promise<SimSession> {
  const { data, error } = await supabase
    .from('live_sessions')
    .insert({
      kind: 'sim',
      title,
      host_id: hostId,
      state: 'running',
      config: {
        phase: 'lobby',
        targetGroupSize: opts.targetGroupSize ?? 5,
        perGroupLimit: opts.perGroupLimit ?? 3,
        pack: opts.pack ?? 'unpaid_labour',
      },
    })
    .select()
    .single();
  if (error) throw error;
  return data as SimSession;
}

export async function closeSimSession(id: string): Promise<void> {
  const { error } = await supabase
    .from('live_sessions')
    .update({ state: 'closed', closed_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// ---- 加入 / 分组 ----

export interface JoinResult {
  participant_id: string;
  phase: SimPhase;
  joined: number;
  group_id: string | null;
  group_no: number | null;
}

export async function joinLobby(sessionId: string): Promise<JoinResult> {
  const { data, error } = await supabase.rpc('sim_join_lobby', { p_session_id: sessionId });
  if (error) throw error;
  return data as JoinResult;
}

export async function assignGroups(sessionId: string): Promise<{ groups: number; joined: number }> {
  const { data, error } = await supabase.rpc('sim_assign_groups', { p_session_id: sessionId });
  if (error) throw error;
  return data as { groups: number; joined: number };
}

// ---- 读取 ----

export async function fetchGroups(sessionId: string): Promise<SimGroup[]> {
  const { data, error } = await supabase
    .from('sim_groups')
    .select('*')
    .eq('session_id', sessionId)
    .order('group_no');
  if (error) throw error;
  return (data ?? []) as SimGroup[];
}

export async function fetchParticipants(sessionId: string): Promise<SimParticipant[]> {
  const { data, error } = await supabase
    .from('live_participants')
    .select('*')
    .eq('session_id', sessionId)
    .order('joined_at');
  if (error) throw error;
  return (data ?? []) as SimParticipant[];
}

export async function fetchQuestions(sessionId: string): Promise<SimQuestion[]> {
  const { data, error } = await supabase
    .from('sim_group_questions')
    .select('*')
    .eq('session_id', sessionId)
    .order('position')
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as SimQuestion[];
}

export async function fetchLatestPaper(sessionId: string): Promise<SimPaper | null> {
  const { data, error } = await supabase
    .from('sim_papers')
    .select('*')
    .eq('session_id', sessionId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as SimPaper) ?? null;
}

export async function fetchPersonas(pack = 'unpaid_labour'): Promise<SimPersona[]> {
  const { data, error } = await supabase
    .from('sim_personas')
    .select('*')
    .eq('pack', pack)
    .order('order_no');
  if (error) throw error;
  return (data ?? []) as SimPersona[];
}

export async function fetchAnswers(sessionId: string, version: number): Promise<SimAnswerRow[]> {
  const { data, error } = await supabase
    .from('sim_persona_answers')
    .select('*')
    .eq('session_id', sessionId)
    .eq('paper_version', version);
  if (error) throw error;
  return (data ?? []) as SimAnswerRow[];
}

export async function fetchInner(sessionId: string, version: number) {
  const { data, error } = await supabase
    .from('sim_persona_inner')
    .select('*')
    .eq('session_id', sessionId)
    .eq('paper_version', version);
  if (error) throw error;
  return (data ?? []) as {
    persona_id: string;
    inner_json: { qid: string; text: string }[];
    closing: string | null;
  }[];
}

export async function fetchReveals(sessionId: string): Promise<SimReveal[]> {
  const { data, error } = await supabase.from('sim_reveals').select('*').eq('session_id', sessionId);
  if (error) throw error;
  return (data ?? []) as SimReveal[];
}

// ---- 写入 ----

export async function saveQuestion(args: {
  sessionId: string;
  questionId?: string | null;
  qtype: SimQType;
  stem: string;
  options: SimOption[];
  position?: number;
}): Promise<string> {
  const { data, error } = await supabase.rpc('sim_save_question', {
    p_session_id: args.sessionId,
    p_question_id: args.questionId ?? null,
    p_qtype: args.qtype,
    p_stem: args.stem,
    p_options: args.options,
    p_position: args.position ?? 0,
  });
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function deleteQuestion(sessionId: string, questionId: string): Promise<void> {
  const { error } = await supabase.rpc('sim_delete_question', {
    p_session_id: sessionId,
    p_question_id: questionId,
  });
  if (error) throw error;
}

export async function freezePaper(sessionId: string, items: SimPaperItem[]): Promise<number> {
  const { data, error } = await supabase.rpc('sim_freeze_paper', {
    p_session_id: sessionId,
    p_items: items,
  });
  if (error) throw error;
  return (data as { version: number }).version;
}

export async function storePersonaResult(args: {
  sessionId: string;
  version: number;
  personaId: string;
  answers: SimAnswerRow['answers'];
  inner: { qid: string; text: string }[];
  closing: string;
  raw?: unknown;
}): Promise<{ answers: number; needed: number }> {
  const { data, error } = await supabase.rpc('sim_store_persona_result', {
    p_session_id: args.sessionId,
    p_version: args.version,
    p_persona_id: args.personaId,
    p_answers: args.answers,
    p_inner: args.inner,
    p_closing: args.closing,
    p_raw: args.raw ?? null,
  });
  if (error) throw error;
  return data as { answers: number; needed: number };
}

export async function reveal(sessionId: string, qid: string, stage: 'answers' | 'inner'): Promise<void> {
  const { error } = await supabase.rpc('sim_reveal', {
    p_session_id: sessionId,
    p_qid: qid,
    p_stage: stage,
  });
  if (error) throw error;
}

// ---- 实时信号 ----

export type SimTable =
  | 'sim_groups'
  | 'sim_group_questions'
  | 'sim_papers'
  | 'sim_persona_answers'
  | 'sim_reveals'
  | 'live_participants';

export function subscribeSim(sessionId: string, onSignal: (table: SimTable) => void): () => void {
  const filter = `session_id=eq.${sessionId}`;
  // channel 名带随机后缀，避免同名复用（2026-10-08 白屏事故的二次防线）
  const channel = supabase
    .channel(`sim:${sessionId}:${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sim_groups', filter }, () =>
      onSignal('sim_groups'),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sim_group_questions', filter }, () =>
      onSignal('sim_group_questions'),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sim_papers', filter }, () =>
      onSignal('sim_papers'),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sim_persona_answers', filter }, () =>
      onSignal('sim_persona_answers'),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sim_reveals', filter }, () =>
      onSignal('sim_reveals'),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_participants', filter }, () =>
      onSignal('live_participants'),
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

// ---- 前端格式校验（只做提示，服务端仍是权威）----

export const STEM_MIN = 6;
export const STEM_MAX = 80;

export function questionError(qtype: SimQType, stem: string, options: SimOption[]): string | null {
  const s = (stem ?? '').trim();
  if (s.length < STEM_MIN) return `题干至少 ${STEM_MIN} 个字`;
  if (s.length > STEM_MAX) return `题干最多 ${STEM_MAX} 个字`;
  if (options.some((o) => o.label.trim().length > 16)) return '单个选项最多 16 个字';
  // 量表只标两端：中间点是数字，不写字（服务端允许空 label）
  if (qtype === 'scale') {
    if (![3, 5, 7].includes(options.length)) return '程度量表只能是 3 / 5 / 7 点';
    if (!options[0]?.label.trim() || !options[options.length - 1]?.label.trim()) {
      return '量表两端要写文案（如 很不满意 / 很满意）';
    }
    return null;
  }
  if (options.length < 2) return '至少需要 2 个选项';
  if (options.length > 6) return '最多 6 个选项';
  if (options.some((o) => !o.label.trim())) return '选项不能留空';
  return null;
}

export const optionKeyAt = (i: number, qtype: SimQType): string =>
  qtype === 'scale' ? String(i + 1) : String.fromCharCode(65 + i);

export function normalizeStem(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
    .trim();
}

export function similarStem(a: string, b: string): boolean {
  const x = normalizeStem(a);
  const y = normalizeStem(b);
  if (x.length < 4 || y.length < 4) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 答案 → 给人看的文字（学生端只读、教师控制台、投屏、历史共用一份口径） */
export function answerText(item: SimPaperItem, value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((k) => {
        const o = item.options.find((x) => x.key === String(k));
        return o ? `${o.key}. ${o.label || '（空）'}` : String(k);
      })
      .join(' / ');
  }
  if (item.qtype === 'scale') {
    const n = Number(value);
    return Number.isFinite(n) ? `${n} / ${item.options.length}` : String(value);
  }
  const o = item.options.find((x) => x.key === String(value));
  return o ? `${o.key}. ${o.label || '（空）'}` : String(value);
}

/** 服务端 RPC 的报错是英文短句：翻成课堂里能懂的提示；不认识的原样透出，不猜 */
export function simErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  if (!raw) return '操作失败，请重试';
  const m = raw.toLowerCase();
  const has = (s: string) => m.includes(s);
  if (has('not authenticated')) return '请先登录';
  if (has('teacher only')) return '只有教师账号能操作这一步';
  if (has('not a sim session')) return '这场活动不是模拟调研';
  if (has('session not found')) return '这场活动不存在（可能已被删除）';
  if (has('session not running')) return '这场活动已经结束了';
  if (has('not in editing phase')) return '现在不在写题阶段（问卷已定稿或活动已结束）';
  if (has('not grouped yet')) return '还没分组，等老师点「开始分组」';
  const limit = raw.match(/group reached limit (\d+)/i);
  if (limit) return `本组已满 ${limit[1]} 题，删一题再加`;
  if (has('not your question')) return '只能改自己写的题（想改队友的，让他来改）';
  if (has('question not found')) return '这道题不存在（可能已被删除）';
  if (has('bad qtype')) return '题型不对，请重选题型';
  if (has('stem length must be 6..80')) return '题干需要 6–80 个字';
  if (has('need 2..6 options')) return '选项需要 2–6 个';
  if (has('option too long')) return '单个选项最多 16 个字';
  if (has('3, 5 or 7')) return '程度量表只能是 3 / 5 / 7 点';
  if (has('option keys must be')) return '选项编号异常，刷新后再试';
  if (has('nobody joined yet')) return '还没有人加入，无法分组';
  if (has('students already wrote questions')) return '已有学生写了题，不能再重新分组';
  if (has('cannot regroup at phase')) return '当前阶段不能重新分组';
  if (has('paper must have 1..8')) return '班级问卷需要 1–8 题';
  if (has('unknown qid')) return '有题目已失效，请刷新后重选';
  if (has('missing or invalid answer')) return '这份作答不完整，已丢弃重试';
  if (has('not ready to reveal')) return '三位受访者还没全部答完';
  if (has('reveal answers first')) return '先公布答案，再公布内心';
  if (has('bad stage')) return '揭晓步骤不对';
  return raw;
}
