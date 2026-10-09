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
-- ============================================================================
-- ⚠ 这里原先定义 `live_submit_answer()`，**已于 2026-10-09 移除**。
--   它已被更新的迁移取代：`db-migration-live-spell-rpc2.sql`。
--   保留旧定义的风险：**重跑本文件会把 db-migration-live-spell-rpc2.sql 装好的新版覆盖回旧版** ——
--   2026-10-08 就是这样出过一次事（`db-migration-xp-c.sql` 覆盖了 `get_daily_study`，
--   学生端连签 / 累计 / 最长纪录集体塌掉）。本文件其余内容不受影响。
-- ============================================================================

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
