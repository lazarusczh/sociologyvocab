-- 修复交卷函数 submit_quiz_submission 不写 status 列的 bug（2026-08-29）
-- 症状：学生已交卷（有 submitted_at、score），但教师后台显示"进行中"、
--       "已提交人数"不增加。
-- 根因：quiz_submissions.status 默认 'in_progress'，而 RPC 交卷函数从未写 status 列，
--       导致 status 一直停留在默认值。前端按 status='submitted' 判断/计数全部失效。
-- 修复：INSERT 写入 status='submitted'；ON CONFLICT UPDATE 时同步更新 status='submitted'。

create or replace function public.submit_quiz_submission(
  quiz_id uuid, user_id uuid, email text, name text, answers jsonb,
  score integer, started_at timestamp with time zone,
  leave_count integer, leave_seconds integer, order_seed integer
) returns void
language plpgsql security definer
set search_path to ''
as $$
declare
  v_kind text;
  v_due_at timestamptz;
begin
  select q.kind, q.due_at
    into v_kind, v_due_at
  from public.quizzes q
  where q.id = $1;

  if not found then
    raise exception 'quiz not found';
  end if;

  if v_kind = 'homework' and v_due_at is not null and now() > v_due_at then
    raise exception 'submission deadline passed';
  end if;

  insert into public.quiz_submissions (
    quiz_id, user_id, email, name, answers, score,
    status,
    started_at, leave_count, leave_seconds, order_seed,
    remaining_seconds, submitted_at
  ) values (
    $1, $2, $3, $4, $5, $6,
    'submitted',
    $7, $8, $9, $10,
    null, now()
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
    submitted_at = now();
end;
$$;
