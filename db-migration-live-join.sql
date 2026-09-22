-- ============================================
-- 实时课堂活动：加入会话 RPC + 密码口子
--
-- 设计：当前一律「一键加入」（join_code 为空 = 无需密码）。将来若出现
-- 「多个班级/多位老师同时活动」需要隔离，只要给 live_sessions.join_code 填值，
-- 校验立刻生效 —— 且校验在服务端（前端绕不过），前端只需多弹一个输入框。
--
-- 幂等，可重复执行。
-- ============================================

alter table public.live_sessions add column if not exists join_code text;

create or replace function public.live_join_session(
  p_session_id uuid,
  p_code text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_state text;
  v_kind text;
  v_join_code text;
  v_pid uuid;
  v_name text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select s.state, s.kind, s.join_code
    into v_state, v_kind, v_join_code
  from public.live_sessions s
  where s.id = p_session_id;

  if not found then
    raise exception 'session not found';
  end if;
  if v_state <> 'running' then
    raise exception 'session not running';
  end if;

  -- 密码口子：空 = 开放加入；填了值就必须匹配
  if v_join_code is not null and v_join_code <> ''
     and p_code is distinct from v_join_code then
    raise exception 'invalid join code';
  end if;

  select p.id into v_pid
  from public.live_participants p
  where p.session_id = p_session_id and p.user_id = v_uid
  limit 1;

  if v_pid is null then
    -- 姓名取 auth.users 的 metadata（权威源），拿不到就留空、由前端兜底显示邮箱前缀
    select u.raw_user_meta_data->>'name' into v_name
    from auth.users u where u.id = v_uid;

    insert into public.live_participants (session_id, user_id, name)
    values (p_session_id, v_uid, v_name)
    returning id into v_pid;
  else
    update public.live_participants set last_seen = now() where id = v_pid;
  end if;

  return jsonb_build_object('participant_id', v_pid, 'session_id', p_session_id, 'kind', v_kind);
end $$;
