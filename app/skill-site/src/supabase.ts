import { createClient } from '@supabase/supabase-js';
import type { SkillData } from './data';

// 与主站同一 Supabase 实例。同域下 supabase-js 默认把 session 存
// localStorage（key = sb-<ref>-auth-token），因此主站登录后本子站自动共享登录态。
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export function getSession() {
  return supabase.auth.getSession();
}

// 拉取最新一版教材知识内容（RLS：仅登录用户可读）
export async function fetchSkillData(): Promise<SkillData | null> {
  const { data, error } = await supabase
    .from('skill_content')
    .select('data')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { data: SkillData } | null)?.data ?? null;
}
