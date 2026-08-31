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

create or replace function public.submit_quiz_submission(
  quiz_id uuid, user_id uuid, email text, name text, answers jsonb,
  score integer, started_at timestamp with time zone,
  leave_count integer, leave_seconds integer, order_seed integer,
  total_points integer default null
) returns void
language plpgsql security definer
set search_path to ''
as $$
declare
  v_kind text;
  v_due_at timestamptz;
  v_allow_late boolean;
  v_late_ms bigint;
  v_late_days integer;
  v_pct integer;
  v_i integer;
  v_penalty integer;
  v_final integer;
  v_grading jsonb;
begin
  select q.kind, q.due_at, q.allow_late
    into v_kind, v_due_at, v_allow_late
  from public.quizzes q
  where q.id = $1;

  if not found then
    raise exception 'quiz not found';
  end if;

  -- 迟交判断：仅作业（homework）且 due_at 已过时处理
  if v_kind = 'homework' and v_due_at is not null and now() > v_due_at then
    if coalesce(v_allow_late, false) = false then
      raise exception 'submission deadline passed';
    end if;
    -- 允许迟交：结算罚分
    v_late_ms := extract(epoch from (now() - v_due_at))::bigint * 1000;
    v_late_days := ceil(v_late_ms::numeric / 86400000)::integer;
    if v_late_days < 1 then
      v_late_days := 1;
    end if;
    v_pct := 0;
    for v_i in 1..v_late_days loop
      v_pct := v_pct + (case
        when v_i = 1 then 10
        when v_i = 2 then 20
        when v_i = 3 then 30
        else 40
      end);
    end loop;
    if v_pct > 100 then
      v_pct := 100;
    end if;
    v_penalty := round(coalesce($11, score)::numeric * v_pct / 100)::integer;
    v_final := greatest(score - v_penalty, 0);
    v_grading := jsonb_build_object(
      'late_days', v_late_days,
      'penalty_percent', v_pct,
      'penalty', v_penalty,
      'bonus', 0,
      'final_score', v_final
    );
  end if;

  insert into public.quiz_submissions (
    quiz_id, user_id, email, name, answers, score,
    status,
    started_at, leave_count, leave_seconds, order_seed,
    remaining_seconds, submitted_at,
    grading
  ) values (
    $1, $2, $3, $4, $5, $6,
    'submitted',
    $7, $8, $9, $10,
    null, now(),
    v_grading
  )
  on conflict on constraint quiz_submissions_quiz_id_user_id_key
  do update set
    email = excluded.email,
    name = excluded.name,
    answers = excluded.answers,
    score = excluded.score,
    status = 'submitted',
    started_at = excluded.started_at,
    leave_count = excluded.leave_count,
    leave_seconds = excluded.leave_seconds,
    order_seed = excluded.order_seed,
    remaining_seconds = null,
    submitted_at = now(),
    grading = excluded.grading;
end;
$$;
