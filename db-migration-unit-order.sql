-- ============================================
-- 单元分类云端同步：vocab_releases 增加 unit_order 字段
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）
-- ============================================

alter table public.vocab_releases
  add column if not exists unit_order jsonb;
