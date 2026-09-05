-- ms_sections 增加外链跳转所需字段（pdf_url + page）
-- 2026-09-05 　psql 整段执行
alter table public.ms_sections add column if not exists pdf_url text;
alter table public.ms_sections add column if not exists page integer;
