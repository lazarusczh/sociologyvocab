import { createClient } from '@supabase/supabase-js';
import type { SkillData } from './data';
import type { PageIndexBook, ScaffoldRow } from './retrieval';

// 与主站同一 Supabase 实例。同域下 supabase-js 默认把 session 存
// localStorage（key = sb-<ref>-auth-token），因此主站登录后本子站自动共享登录态。
//
// ⚠️ 必须复用主站的 `resilientFetch`（直连优先 + 同源代理兜底）：本子站原先自建了裸客户端，
// 结果在"不信任 Supabase 主机证书"的设备上（信任库较旧的 Android）全部加载失败——
// 主站有回退、子站没有，同一台设备上主站能用、子站一直转圈（2026-09-13 实测踩到）。
import { SUPABASE_URL, SUPABASE_ANON_KEY, resilientFetch } from '../../src/lib/supabaseFetch';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: resilientFetch },
});

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
      terms?: PageIndexBook['terms'];
    };
  }[]).map((r) => ({
    book: r.book,
    pages: r.data?.pages ?? [],
    units: r.data?.units ?? {},
    chapters: r.data?.chapters ?? {},
    terms: r.data?.terms ?? [],
  }));
}

/** 章节答题脚手架（按章注入 system 的教师口径）。 */
export async function fetchScaffolds(): Promise<ScaffoldRow[]> {
  const { data, error } = await supabase.from('skill_scaffolds').select('book, chapter, data');
  if (error) throw error;
  return (data ?? []) as ScaffoldRow[];
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
