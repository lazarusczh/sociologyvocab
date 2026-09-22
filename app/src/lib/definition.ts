// 定义题数据层：题目（definition_items）+ 作答日志（definition_attempts）
//
// 可见性：题目对登录用户只读；作答日志 RLS 仅本人可写/可读（教师/开发者可读全部并复核）。
// 题目与词库条目按 term 关联（同术语即同一条目），用于把结果写进掌握度与错题本。
import { supabase } from './supabase';
import type { Verdict } from './ai';

export interface DefinitionKeypoint {
  text: string;
  source?: string;
  kind?: 'required' | 'example';   // required = 定义主干（必须答到）；example = 并列举例（举若干项即可）
  en?: string;                     // 该要素在权威来源英文原文里的对应表述（跨语言判分 / 展示用）
}

export interface DefinitionItem {
  id: string;                     // 术语归一化 slug
  term: string;
  chinese: string | null;
  paper: string | null;
  units: string[] | null;
  reference: string | null;       // 参考来源 key（main / tb1 / igcse0495 …）
  keypoints: DefinitionKeypoint[]; // 必踩点
  bonus: DefinitionKeypoint[];     // 加分点（其他来源独有，不要求必答）
  source_defs?: Record<string, string> | null; // 各来源英文原文（判分时的语义参照，不参与计分）
}

/** 拉取全部启用中的题目（一次拉完，前端本地抽样） */
export async function loadDefinitionItems(): Promise<DefinitionItem[]> {
  const { data, error } = await supabase
    .from('definition_items')
    .select('id, term, chinese, paper, units, reference, keypoints, bonus, source_defs')
    .eq('active', true)
    .order('id');
  if (error) throw error;
  return ((data ?? []) as unknown as DefinitionItem[]).map((r) => ({
    ...r,
    keypoints: Array.isArray(r.keypoints) ? r.keypoints : [],
    bonus: Array.isArray(r.bonus) ? r.bonus : [],
  }));
}

export interface AttemptPayload {
  itemId: string;
  answer: string;
  verdict: Verdict;
  coverage: number[];
  listingOnly: boolean;
  reason: string;
  model: string;
  tier: string;
  ms: number;
  /** 判分模型把学生答案理解成了哪些含义（判分提示词「第一步」的输出） */
  restate?: string[];
}

/**
 * 写一条作答日志，成功时返回该记录 id（供「提交质疑」关联）。
 * 失败不抛：练习体验优先，日志缺失不影响判分展示 —— 返回 null。
 */
export async function saveDefinitionAttempt(p: AttemptPayload): Promise<number | null> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id;
  if (!userId) return null;
  const { data: row, error } = await supabase
    .from('definition_attempts')
    .insert({
      user_id: userId,
      item_id: p.itemId,
      answer: p.answer,
      verdict: p.verdict,
      coverage: p.coverage,
      listing_only: p.listingOnly,
      reason: p.reason,
      restate: p.restate ?? [],
      model: p.model,
      tier: p.tier,
      ms: p.ms,
    })
    .select('id')
    .maybeSingle();
  if (error) return null;
  return (row as { id: number } | null)?.id ?? null;
}

/**
 * 学生对某次判分提出质疑。
 *
 * 走 RPC（`security definer`）而不是直接 UPDATE：学生只应能改自己的「质疑」字段，
 * 不该为了这个功能对整表开放更新权限。成功返回 null，失败返回可读错误信息。
 */
export async function submitDefinitionDispute(attemptId: number, note: string): Promise<string | null> {
  const { error } = await supabase.rpc('submit_definition_dispute', {
    p_attempt_id: attemptId,
    p_note: note.trim() || null,
  });
  return error ? error.message : null;
}

/**
 * 本人获得的经验值加分（教师签发的「质疑奖励」等）；XP 体系上线后与本地 XP 合并。
 *
 * ⚠️ **必须显式按 `user_id` 过滤，不能只靠 RLS**（2026-09-22 修）：
 * `student_xp_bonus` 有两条 select 策略 —— 学生走 `read_own`（`auth.uid() = user_id`），
 * **教师/开发者走 `read_staff`（返回全校）**。原先只写 `select('amount')`，
 * 于是同一个函数在教师身份下会返回**全校总分**，与函数名「我的」严重不符，
 * 将来教师端页面顺手调用就会算错。过滤条件放在这里，身份无关、行为确定。
 *
 * ⚠️ **使用的唯一纪律：现算相加，永不落盘。** 返回值只用于「展示时相加」，
 * 绝不可写进 `socio_vocab_xp.xp` 或 `student_data.data.xp` ——
 * 一旦落盘（尤其随整包上传），下次读又会再加一遍，形成无限重复累加。
 */
export async function loadMyXpBonus(): Promise<number> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return 0;
  const { data, error } = await supabase.from('student_xp_bonus').select('amount').eq('user_id', uid);
  if (error) return 0;
  return ((data ?? []) as { amount: number }[]).reduce((s, r) => s + (r.amount ?? 0), 0);
}
