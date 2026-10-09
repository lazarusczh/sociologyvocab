-- 作业迟交放行 + 迟交罚分（2026-08-30）
-- 1) quizzes 加 allow_late：教师勾选后该作业允许迟交（不硬拦截，只按 grading 规则罚分）
-- 2) quiz_submissions 加 grading：评分结算明细（penalty 迟交罚分 / final_score 最终分）
-- 3) RPC 重写：允许迟交的作业放开 due_at 硬拦截；作业迟交时按规则写 penalty 到 grading

-- ===== 1. 表结构 =====
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS allow_late boolean NOT NULL DEFAULT false;

ALTER TABLE public.quiz_submissions
  ADD COLUMN IF NOT EXISTS grading jsonb;

-- ===== 2. RPC：交卷函数（含迟交放行 + 罚分结算） =====
-- 说明：
--   - 测验（quiz）：不受 allow_late 影响，due_at 仅作结果公布时间，不拦截（quiz 无迟到概念）
--   - 作业（homework）：
--       · allow_late = true  → 过了 due_at 仍可交，按迟到天数结算罚分写 grading
--       · allow_late = false → 过了 due_at 硬拦截（raise submission deadline passed），维持现状
--   - 罚分：lateDays = ceil((now - due_at)/86400000)，累积百分比 daily_percents=[10,20,30,40]，
--     封顶 100%；penalty = round(满分M × penaltyPercent / 100)；final_score = clamp(score - penalty, 0, M)
--   - 满分 M：由前端 totalPoints(questions) 得出，作为参数传入（避免服务端重复计算题目快照）

-- ============================================================================
-- ⚠ 这里原先定义 `submit_quiz_submission()`，**已于 2026-10-09 移除**。
--   它已被更新的迁移取代：`db-migration-grading-rules.sql`。
--   保留旧定义的风险：**重跑本文件会把 db-migration-grading-rules.sql 装好的新版覆盖回旧版** ——
--   2026-10-08 就是这样出过一次事（`db-migration-xp-c.sql` 覆盖了 `get_daily_study`，
--   学生端连签 / 累计 / 最长纪录集体塌掉）。本文件其余内容不受影响。
-- ============================================================================
