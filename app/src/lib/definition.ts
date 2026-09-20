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
}

/** 写一条作答日志（失败不抛：练习体验优先，日志缺失不影响判分展示） */
export async function saveDefinitionAttempt(p: AttemptPayload): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id;
  if (!userId) return false;
  const { error } = await supabase.from('definition_attempts').insert({
    user_id: userId,
    item_id: p.itemId,
    answer: p.answer,
    verdict: p.verdict,
    coverage: p.coverage,
    listing_only: p.listingOnly,
    reason: p.reason,
    model: p.model,
    tier: p.tier,
    ms: p.ms,
  });
  return !error;
}
