-- ============================================
-- 实时课堂活动（拼写竞赛）RPC 第一批：开轮 + 提交判定
--
-- 铁律（见《实时多人在线功能规划.md》第七节）：
--   1) 判定只在服务端：术语从 live_round_secrets 取（学生读不到），输入过 normalize_answer 后
--      查 vocab_answer_forms；前端只发原文，绝不上报 is_correct。
--   2) 提交永不抢占：本轮已有人答对也照常接受（抢答段的并列由结算时按时间窗聚合）。
--   3) 时间戳一律服务端 now()：不接受任何客户端时间。
--   4) 抽题在教师端（前端有整份词库与难度口径），RPC 只负责落库并把 deadline 算成服务端时间。
--
-- 幂等，可重复执行。
-- ============================================

-- ---------------------------------------------------------------
-- 开一轮（教师）：写轮次 + 术语（secrets）+ 广播事件
--   p_stage: 'knockout' 淘汰段 / 'buzz' 抢答段
--   p_seconds: 本题限时秒数；null 或 <=0 = 不限时
-- ---------------------------------------------------------------
create or replace function public.live_open_round(
  p_session_id uuid,
  p_group_no int,
  p_round_no int,
  p_stage text,
  p_prompt text,
  p_term_id text,
  p_seconds int
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role = 'teacher'
  ) then
    raise exception 'only teacher can open a round';
  end if;

  insert into public.live_spell_rounds (session_id, group_no, round_no, stage, prompt, state, deadline_at)
  values (
    p_session_id, p_group_no, p_round_no, p_stage, p_prompt, 'open',
    case when p_seconds is null or p_seconds <= 0 then null else now() + make_interval(secs => p_seconds) end
  )
  returning id into v_id;

  insert into public.live_round_secrets (round_id, term_id) values (v_id, p_term_id);

  insert into public.live_events (session_id, type, payload)
  values (
    p_session_id, 'open_round',
    jsonb_build_object('round_id', v_id, 'group_no', p_group_no, 'round_no', p_round_no, 'stage', p_stage)
  );

  return v_id;
end $$;

-- ---------------------------------------------------------------
-- 提交作答（学生）：判定 + 写行 + 更新计数
--   返回 { is_correct, already, reason }
--     already=true 表示本条是重复提交，返回首次结果、不改写
--   超时 / 已结算 / 轮次不存在都会抛异常（前端据此提示）
-- ---------------------------------------------------------------
create or replace function public.live_submit_answer(
  p_round_id uuid,
  p_text text
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

  -- 只认第一条（与「限时内未提交算淘汰」「答错后不能再提交」一致）
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
  if v_deadline is not null and now() > v_deadline then
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

  -- 首个答对者的服务端时间 = 抢答段并列窗的基准
  v_first := v_ok and not exists (
    select 1 from public.live_spell_rounds r
    where r.id = p_round_id and r.first_correct_at is not null
  );

  update public.live_spell_rounds
     set answered_count = answered_count + 1,
         correct_count = correct_count + (case when v_ok then 1 else 0 end),
         first_correct_at = case
           when v_first then now()
           else first_correct_at
         end
   where id = p_round_id;

  return jsonb_build_object('is_correct', v_ok, 'already', false, 'reason', 'ok');
end $$;

-- ---------------------------------------------------------------
-- 防重复提交的兜底：同一轮同一人只允许一行
--   （RPC 已做「查过就不再写」，这里再上一层数据库约束；
--     现代码用 DO 块包裹，若内核不支持 ALTER 加唯一约束也只是跳过、不影响前面的函数）
-- ---------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'live_spell_answers_round_user_key'
  ) then
    alter table public.live_spell_answers
      add constraint live_spell_answers_round_user_key unique (round_id, user_id);
  end if;
end $$;
