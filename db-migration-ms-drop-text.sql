-- ms_sections 删除过渡用 text 列（外链 PDF 方案已稳定，2026-09-05 用户确认）
-- 注意：删除不可逆；若需离线兜底可先备份（pg_dump）
alter table public.ms_sections drop column if exists text;
