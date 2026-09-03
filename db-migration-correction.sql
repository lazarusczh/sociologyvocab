-- 作业订正（错题重做 + 加分）数据层增量（2026-09-03）
-- 方案：作业加分与罚分方案.md（订正章节）
-- 变更：quiz_submissions.correction jsonb —— 订正答题明细；非 null 即视为已订正（不可重复订正的判据）
-- 说明：
--   * 加分规则随 quizzes.grading_rules.correction_bonus 快照，由前端创建/更新作业时写入，
--     本迁移不改 grading_rules 结构（jsonb 动态）。
--   * 学生写自己的 correction / grading 列已由 db-migration-quiz.sql 的
--     quiz_submissions_student_update 策略（auth.uid() = user_id）覆盖，无需新增 RLS。
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）

alter table public.quiz_submissions
  add column if not exists correction jsonb;

-- 可选索引：若后续按“已订正/未订正”做批量查询时再放开
-- create index if not exists idx_quiz_submissions_correction
--   on public.quiz_submissions (quiz_id) where correction is null;
