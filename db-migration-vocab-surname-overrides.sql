-- ============================================
-- 特殊姓氏覆盖上云：vocab_releases 增加 surname_overrides 字段
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）
--
-- 背景：判定逻辑（app/src/lib/answers.ts）直接读本机存储取「特殊姓氏覆盖」，
--       导致教师手工指定的写法（如 bell hooks 该认哪个词当姓氏）只在教师本机生效，
--       学生端完全拿不到 → 同一条学者名题，教师机器判对、学生机器判错。
-- 改法：随「发布词库」一起下发；客户端合并优先级 = 内置默认 < 云端发布 < 本机手工配置
--       （教师端本机尚未发布的改动仍然优先）。
-- 兼容：历史发布该字段为 NULL，客户端按「没有就用本机」降级，不报错、不清空本机配置。
-- ============================================

alter table public.vocab_releases
  add column if not exists surname_overrides jsonb;
