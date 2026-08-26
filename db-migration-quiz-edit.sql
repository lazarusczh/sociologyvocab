-- ============================================
-- 随堂测验/作业 增量：支持教师编辑测验
-- 给 quizzes 加 type_filter 字段（编辑时恢复类型筛选）
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）
-- ============================================

alter table public.quizzes
  add column if not exists type_filter text not null default 'all';
