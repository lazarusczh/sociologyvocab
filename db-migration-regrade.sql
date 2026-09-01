-- 作业/测验重判 RPC（2026-09-01）
-- 背景：拼写判分容错规则调整（如 & 与 and 等价）后，已提交的旧卷需要按新规则重判。
-- 限制：quiz_submissions 的 RLS 只允许学生改自己的卷，教师无法直接 update，故用 security definer RPC。
-- 用法：前端把 <submission_id, 新分数> 传入，函数批量更新 score；若原卷有迟交罚分，同步重算 final_score。
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）

create or replace function public.regrade_quiz_submissions(
  p_quiz_id uuid,
  p_scores jsonb
)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_role text;
  v_count integer := 0;
  s record;
begin
  -- 权限：仅 teacher / developer 可调用
  select r.role into v_role from public.user_roles r where r.user_id = auth.uid();
  if v_role is null or v_role not in ('teacher', 'developer') then
    raise exception 'permission denied';
  end if;

  -- p_scores 形如 {"<submission_id>": <new_score>}
  for s in select key::uuid as sub_id, value::int as new_score
           from jsonb_each_text(p_scores) loop
    update public.quiz_submissions
    set score = s.new_score,
        grading = case
          when grading is not null and (grading->>'penalty') is not null
            then jsonb_set(grading, '{final_score}', to_jsonb(greatest(s.new_score - (grading->>'penalty')::int, 0)))
          else grading
        end
    where id = s.sub_id and quiz_id = p_quiz_id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
