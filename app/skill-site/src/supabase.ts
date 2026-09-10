import { createClient } from '@supabase/supabase-js';
import type { SkillData } from './data';
import type { PageIndexBook } from './retrieval';

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

// ===== 教材原文页两级检索支持（索引常驻 / 原文按需取页）=====

/** 页级索引：每本一行 jsonb，体积小、随知识库一起下发，用于把问题定位到页码。 */
export async function fetchPageIndex(): Promise<PageIndexBook[]> {
  const { data, error } = await supabase.from('skill_page_index').select('book, data');
  if (error) throw error;
  return ((data ?? []) as {
    book: string;
    data: {
      pages?: PageIndexBook['pages'];
      units?: PageIndexBook['units'];
      chapters?: PageIndexBook['chapters'];
    };
  }[]).map((r) => ({
    book: r.book,
    pages: r.data?.pages ?? [],
    units: r.data?.units ?? {},
    chapters: r.data?.chapters ?? {},
  }));
}

/** 按需拉取命中的页原文（一次查询取多页，避免逐页请求）。 */
export async function fetchPageTexts(
  book: string,
  pages: number[],
): Promise<{ page: number; chapter: string; text: string }[]> {
  if (!pages.length) return [];
  const { data, error } = await supabase
    .from('skill_pages')
    .select('page, chapter, text')
    .eq('book', book)
    .in('page', pages);
  if (error) throw error;
  return (data ?? []) as { page: number; chapter: string; text: string }[];
}
