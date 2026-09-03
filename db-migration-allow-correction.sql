-- 作业是否允许订正：由教师逐项决定（2026-09-03）
-- 默认 true（允许订正），与既有行为一致；教师在创建/编辑作业时可关闭。
-- 测验（quiz）恒不允许订正，该列对测验无意义（前端表单不展示、不改写）。
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）

alter table public.quizzes
  add column if not exists allow_correction boolean not null default true;
