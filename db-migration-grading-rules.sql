-- 评分规则：教师默认规则表 + 作业规则快照 + 迟交罚分按快照结算（2026-08-30）
-- 设计（作业加分与罚分方案.md）：
--   - teacher_grading_rules：教师默认规则（影响新创建的作业）
--   - quizzes.grading_rules：创建作业时的规则快照（历史作业不受教师改默认规则影响）
--   - submit_quiz_submission 读该作业的快照规则结算迟交罚分；无快照用内置默认

-- ===== 1. 结构 =====
ALTER TABLE public.quizzes
  ADD COLUMN IF NOT EXISTS grading_rules jsonb;

CREATE TABLE IF NOT EXISTS public.teacher_grading_rules (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  rules jsonb NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- ===== 2. RPC：交卷函数（迟交放行 + 按规则快照罚分） =====
-- 规则结构：
--   { "late_penalty": { "enabled": true, "daily_percents": [10,20,30,40] } }
-- 罚分：lateDays = ceil((now - due_at)/86400000)；
--       累积 pct = sum(daily_percents[0..lateDays-1])，封顶 100；
--       penalty = round(M * pct / 100)；final = clamp(score - penalty, 0, M)

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
  v_rules jsonb;
  v_enabled boolean;
  v_percents jsonb;
  v_late_ms bigint;
  v_late_days integer;
  v_pct integer;
  v_i integer;
  v_p integer;
  v_penalty integer;
  v_final integer;
  v_grading jsonb;
begin
  select q.kind, q.due_at, q.allow_late, q.grading_rules
    into v_kind, v_due_at, v_allow_late, v_rules
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
    -- 读取规则快照（无快照/缺字段用内置默认 [10,20,30,40]）
    v_enabled := coalesce((v_rules #>> '{late_penalty,enabled}')::boolean, true);
    v_percents := v_rules #> '{late_penalty,daily_percents}';
    if v_percents is null or jsonb_array_length(v_percents) = 0 then
      v_percents := '[10,20,30,40]'::jsonb;
    end if;
    if v_enabled then
      v_late_ms := extract(epoch from (now() - v_due_at))::bigint * 1000;
      v_late_days := ceil(v_late_ms::numeric / 86400000)::integer;
      if v_late_days < 1 then v_late_days := 1; end if;
      v_pct := 0;
      for v_i in 1..v_late_days loop
        v_p := (v_percents ->> (v_i - 1));
        if v_p is null then
          -- 超出数组长度：沿用最后一个值（或默认 40）
          v_p := (v_percents ->> (jsonb_array_length(v_percents) - 1))::text;
        end if;
        v_pct := v_pct + coalesce(v_p::integer, 40);
      end loop;
      if v_pct > 100 then v_pct := 100; end if;
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
