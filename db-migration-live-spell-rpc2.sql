-- ============================================
-- 实时课堂活动（拼写竞赛）RPC 第二批：提交宽限 + 回合初始化 + 结算
--
-- 幂等，可重复执行。
-- 相关口径见《实时多人在线功能规划.md》第七节：
--   · 限时判定留 1 秒宽限（网络抖动同样影响「准时到达」，与抢答窗同一个理由）
--   · 抢答段胜负按时间窗聚合（并列），不做抢占
--   · 并列占顺位：2 人并列第 1 ⇒ 剩下一人是第 3 名
--   · 抢答段无人在窗口内答对 ⇒ 当前存活者全部并列第 1（教师 2026-09-22 定）
-- ============================================

-- ---------------------------------------------------------------
-- 1. 提交（学生）——重建，新增宽限参数
--    参数列表变了，必须先 drop 旧签名，否则会变成「重载」而留下二义性
-- ---------------------------------------------------------------
drop function if exists public.live_submit_answer(uuid, text);

create or replace function public.live_submit_answer(
  p_round_id uuid,
  p_text text,
  p_grace_seconds int default 1
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_session uuid;
  v_group int;
  v_state text;
  v_deadline timestamptz;
  v_term text;
  v_ok boolean;
  v_first boolean;
  v_prev record;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select r.session_id, r.group_no, r.state, r.deadline_at
    into v_session, v_group, v_state, v_deadline
  from public.live_spell_rounds r
  where r.id = p_round_id;

  if not found then
    raise exception 'round not found';
  end if;

  -- 只认第一条（限时内未提交算淘汰；答错后不能再提交）
  select a.is_correct into v_prev
  from public.live_spell_answers a
  where a.round_id = p_round_id and a.user_id = v_uid
  limit 1;

  if found then
    return jsonb_build_object('is_correct', v_prev.is_correct, 'already', true, 'reason', 'first answer kept');
  end if;

  if v_state <> 'open' then
    raise exception 'round already settled';
  end if;

  -- 宽限：只影响「这次提交收不收」，不影响展示给学生的限时
  if v_deadline is not null
     and now() > v_deadline + make_interval(secs => coalesce(p_grace_seconds, 0)) then
    raise exception 'deadline passed';
  end if;

  select s.term_id into v_term
  from public.live_round_secrets s
  where s.round_id = p_round_id
  limit 1;

  if v_term is null then
    raise exception 'round has no secret';
  end if;

  v_ok := exists (
    select 1 from public.vocab_answer_forms f
    where f.term_id = v_term
      and f.form_normalized = public.normalize_answer(coalesce(p_text, ''))
  );

  insert into public.live_spell_answers (round_id, session_id, group_no, user_id, text, is_correct)
  values (p_round_id, v_session, v_group, v_uid, coalesce(p_text, ''), v_ok);

  v_first := v_ok and not exists (
    select 1 from public.live_spell_rounds r
    where r.id = p_round_id and r.first_correct_at is not null
  );

  update public.live_spell_rounds
     set answered_count = answered_count + 1,
         correct_count = correct_count + (case when v_ok then 1 else 0 end),
         first_correct_at = case when v_first then now() else first_correct_at end
   where id = p_round_id;

  return jsonb_build_object('is_correct', v_ok, 'already', false, 'reason', 'ok');
end $$;

-- ---------------------------------------------------------------
-- 2. 初始化一个回合（教师）：把当前在线参与者复制成「本回合存活者」
--    每回合一次，之后该回合内不再重复插入。
-- ---------------------------------------------------------------
create or replace function public.live_start_group(
  p_session_id uuid,
  p_group_no int
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_added int;
begin
  if not exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role = 'teacher'
  ) then
    raise exception 'only teacher can start a group';
  end if;

  insert into public.live_spell_state (session_id, group_no, user_id, name)
  select p.session_id, p_group_no, p.user_id, p.name
  from public.live_participants p
  where p.session_id = p_session_id
    and not exists (
      select 1 from public.live_spell_state st
      where st.session_id = p_session_id and st.group_no = p_group_no and st.user_id = p.user_id
    );

  get diagnostics v_added = row_count;
  return v_added;
end $$;

-- ---------------------------------------------------------------
-- 3. 结算一轮（教师）
--    淘汰段：本轮在时限内答对者存活（survived_rounds +1），其余（答错 / 未提交）淘汰
--    抢答段：按时间窗聚合并列胜者，定前三名并记分（回合一并结束）
--    幂等：已结算的轮直接返回 already
-- ---------------------------------------------------------------
create or replace function public.live_settle_round(
  p_round_id uuid,
  p_buzz_window_ms int default 1000
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session uuid;
  v_group int;
  v_round_no int;
  v_stage text;
  v_state text;
  v_cfg jsonb;
  v_p1 int;
  v_p2 int;
  v_p3 int;
  v_base timestamptz;
  v_winners uuid[];
  v_alive int;
  v_alive_after int;
begin
  if not exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role = 'teacher'
  ) then
    raise exception 'only teacher can settle a round';
  end if;

  select r.session_id, r.group_no, r.round_no, r.stage, r.state
    into v_session, v_group, v_round_no, v_stage, v_state
  from public.live_spell_rounds r
  where r.id = p_round_id;

  if not found then
    raise exception 'round not found';
  end if;
  if v_state = 'settled' then
    return jsonb_build_object('already', true, 'stage', v_stage);
  end if;

  select coalesce(s.config, '{}'::jsonb) into v_cfg
  from public.live_sessions s where s.id = v_session;
  v_p1 := coalesce(nullif(v_cfg->>'points_rank1', '')::int, 3);
  v_p2 := coalesce(nullif(v_cfg->>'points_rank2', '')::int, 2);
  v_p3 := coalesce(nullif(v_cfg->>'points_rank3', '')::int, 1);

  select count(*) into v_alive
  from public.live_spell_state st
  where st.session_id = v_session and st.group_no = v_group and st.out_round_no is null;

  if v_stage = 'knockout' then
    -- 存活：本轮答对
    update public.live_spell_state st
       set survived_rounds = st.survived_rounds + 1, updated_at = now()
     where st.session_id = v_session and st.group_no = v_group and st.out_round_no is null
       and exists (
         select 1 from public.live_spell_answers a
         where a.round_id = p_round_id and a.user_id = st.user_id and a.is_correct
       );

    -- 其余（含未提交者）淘汰
    update public.live_spell_state st
       set out_round_no = v_round_no, updated_at = now()
     where st.session_id = v_session and st.group_no = v_group and st.out_round_no is null
       and not exists (
         select 1 from public.live_spell_answers a
         where a.round_id = p_round_id and a.user_id = st.user_id and a.is_correct
       );
  else
    -- 抢答段：窗口内答对者并列第 1
    select a.created_at into v_base
    from public.live_spell_answers a
    where a.round_id = p_round_id and a.is_correct
    order by a.created_at asc
    limit 1;

    if v_base is null then
      -- 无人答对 ⇒ 当前存活者全部并列第 1（教师 2026-09-22 定）
      update public.live_spell_state st
         set rank_in_group = 1, points = st.points + v_p1, updated_at = now()
       where st.session_id = v_session and st.group_no = v_group and st.out_round_no is null;
      v_winners := array[]::uuid[];
    else
      select array_agg(a.user_id order by a.created_at) into v_winners
      from public.live_spell_answers a
      where a.round_id = p_round_id and a.is_correct
        and a.created_at <= v_base + make_interval(secs => coalesce(p_buzz_window_ms, 1000) / 1000.0);

      update public.live_spell_state st
         set rank_in_group = 1, points = st.points + v_p1, updated_at = now()
       where st.session_id = v_session and st.group_no = v_group and st.out_round_no is null
         and st.user_id = any (v_winners);

      -- 其余人按「占顺位」排名：1 个胜者 ⇒ 第 2；2 个胜者 ⇒ 第 3
      update public.live_spell_state st
         set rank_in_group = 1 + coalesce(array_length(v_winners, 1), 0),
             points = st.points + (case
               when 1 + coalesce(array_length(v_winners, 1), 0) = 2 then v_p2
               else v_p3
             end),
             updated_at = now()
       where st.session_id = v_session and st.group_no = v_group and st.out_round_no is null
         and not (st.user_id = any (v_winners));
    end if;

    insert into public.live_events (session_id, type, payload)
    values (
      v_session, 'group_settled',
      jsonb_build_object(
        'group_no', v_group,
        'round_id', p_round_id,
        'winners', coalesce(to_jsonb(v_winners), '[]'::jsonb)
      )
    );
  end if;

  update public.live_spell_rounds
     set state = 'settled',
         settled_at = now(),
         solved_users = case when v_stage = 'buzz' then coalesce(to_jsonb(v_winners), '[]'::jsonb) else solved_users end
   where id = p_round_id;

  select count(*) into v_alive_after
  from public.live_spell_state st
  where st.session_id = v_session and st.group_no = v_group and st.out_round_no is null;

  return jsonb_build_object(
    'already', false,
    'stage', v_stage,
    'alive_before', v_alive,
    'alive_after', v_alive_after,
    'winners', coalesce(to_jsonb(v_winners), '[]'::jsonb),
    'group_finished', v_stage = 'buzz'
  );
end $$;
