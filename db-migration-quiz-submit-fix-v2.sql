-- 修复交卷 RPC 函数 submit_quiz_submission 的 "column reference quiz_id is ambiguous"（2026-08-29）
-- 根因：ON CONFLICT (quiz_id, user_id) 裸列名在 SECURITY DEFINER + 空 search_path + 参数同名
--       的上下文里会与函数参数 quiz_id/user_id 冲突（8-27 已实测，正确写法是 ON CONFLICT ON CONSTRAINT）。
--       此前 Trae 的修复只改了 $1..$n 位置参数，但保留了裸列名，故仍然报 ambiguous。
-- 修复：ON CONFLICT ON CONSTRAINT quiz_submissions_quiz_id_user_id_key

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
    started_at, leave_count, leave_seconds, order_seed,
    remaining_seconds, submitted_at
  ) values (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10,
    null, now()
  )
  on conflict on constraint quiz_submissions_quiz_id_user_id_key
  do update set
    email = excluded.email,
    name = excluded.name,
    answers = excluded.answers,
    score = excluded.score,
    started_at = excluded.started_at,
    leave_count = excluded.leave_count,
    leave_seconds = excluded.leave_seconds,
    order_seed = excluded.order_seed,
    remaining_seconds = null,
    submitted_at = now();
end;
$$;
