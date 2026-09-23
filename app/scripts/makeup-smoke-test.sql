-- 补签服务端化 冒烟测试
-- 全程一个事务，最后 ROLLBACK —— 不留任何测试数据。
--
-- 重点验证三件事：
--   ① 口径：correct = sum(score)（partial 记 0.5）；基线 seconds 要 ×1000 转毫秒
--   ② apply_makeup 的完整拒绝路径（四种）
--   ③ 权限收口：daily_study_of 客户端不可调；get_daily_study_all 仅 staff
\set ON_ERROR_STOP on
\pset pager off

begin;

-- 测试用假 uid（末段 dd），绝不会与真实学生冲突
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000dd"}', true) as jwt_ok;

-- 按「今天」动态算出本周一、昨天、今天，避免测试写死日期后隔天失效
create temp table tctx on commit drop as
select (now() at time zone 'Asia/Shanghai')::date as today,
       date_trunc('week', (now() at time zone 'Asia/Shanghai')::date)::date as monday;
select (select monday from tctx) as monday, (select today from tctx) as today;

\echo ''
\echo '===== 1) 口径：correct = sum(score)（含 partial 0.5），correct_full 只数全对 ====='
-- 造 6 题：4 题全对(score 1) + 2 题 partial(score 0.5) ⇒ sum(score)=5，布尔全对=4
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
    'event_id', ('11111111-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'kind','answer','item_id','mx-' || i,'mode','definition',
    'correct', (i <= 4),                       -- 前 4 题全对，后 2 题 partial
    'score',   (case when i <= 4 then 1 else 0.5 end),
    'elapsed_ms', 30000,
    'answered_at', ((select monday from tctx) + interval '1 day' + (i || ' minutes')::interval)::timestamptz))
  from generate_series(1, 6) i
));
select x.day_key, x.questions, x.correct, x.correct_full
  from jsonb_to_recordset(public.get_daily_study())
       as x(day_key date, questions int, correct numeric, correct_full int, makeup boolean)
 where x.day_key = (select monday from tctx) + 1;
\echo '  ↑ questions=6, correct 应为 5.00（4×1 + 2×0.5）, correct_full 应为 4'

\echo ''
\echo '===== 2) 口径：baseline 的 seconds 是「秒」，合并后必须是毫秒（×1000）====='
-- 在更早的某天插一条基线：200 秒、10 题、correct 9.5
insert into public.checkin_baselines (user_id, day_key, questions, seconds, correct)
values ('00000000-0000-0000-0000-0000000000dd', (select monday from tctx) - 30, 10, 200, 9.5);

select x.day_key, x.questions, x.ms, x.correct, x.correct_full, x.makeup
  from jsonb_to_recordset(public.get_daily_study())
       as x(day_key date, questions int, ms int, correct numeric, correct_full int, makeup boolean)
 where x.day_key = (select monday from tctx) - 30;
\echo '  ↑ ms 应为 200000（200 秒 ×1000）；correct 应为 9.50；correct_full 应为 NULL（基线没存过布尔计数）'

\echo ''
\echo '===== 3) 拒绝：目标日是今天或未来 ⇒ not_past_day ====='
select public.apply_makeup((select today from tctx)) as r_today;
select public.apply_makeup((select today from tctx) + 1) as r_future;

\echo ''
\echo '===== 4) 拒绝：不属于本周 ⇒ not_this_week ====='
select public.apply_makeup((select monday from tctx) - 7) as r_last_week;

\echo ''
\echo '===== 5) 拒绝：本周题数不足（此时本周只有 6 题）⇒ week_questions_low ====='
select public.apply_makeup((select monday from tctx)) as r_low_q;

\echo ''
\echo '===== 6) 通过：补足到本周 ≥100 题且正确率 ≥80%，再补周一 ⇒ ok ====='
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
    'event_id', ('22222222-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'kind','answer','item_id','mq-' || i,'mode','choice',
    'correct', true, 'score', 1, 'elapsed_ms', 6000,
    'answered_at', ((select monday from tctx) + interval '2 days' + (i || ' minutes')::interval)::timestamptz))
  from generate_series(1, 100) i
));
select public.apply_makeup((select monday from tctx)) as r_ok;

\echo ''
\echo '===== 7) 拒绝：本周已补过 ⇒ week_already_used（unique(user_id, week_start) 兜底）====='
select public.apply_makeup((select monday from tctx) + 1) as r_used;

\echo ''
\echo '===== 8) 拒绝：目标日已达标 ⇒ already_checked ====='
-- ⚠ 用一个独立的假学生（末段 ee），并造在「昨天」而不是本周任意一天：
--   造在今天之后会被 submit_xp_events 的 future_time 防线拦下（本用例第一版就踩了这个坑），
--   而造在「昨天」既落在本周内、又早于今天，能通过 apply_makeup 的前两道校验，
--   从而真正走到 already_checked 这一支。
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ee"}', true);
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
    'event_id', ('33333333-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'kind','answer','item_id','mc-' || i,'mode','choice',
    'correct', true, 'score', 1, 'elapsed_ms', 35000,
    'answered_at', ((select today from tctx) - 1 + (i || ' minutes')::interval)::timestamptz))
  from generate_series(1, 20) i
));
select public.apply_makeup((select today from tctx) - 1) as r_checked;
\echo '  ↑ 该日已达标（20 题 + 700 秒）⇒ 应返回 already_checked'

-- 切回第一个假学生（第 8 项为了造 already_checked 换过 uid），否则读不到它的补签
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000dd"}', true);

\echo ''
\echo '===== 9) 补签结果已落表，且 get_daily_study 能读到 makeup=true ====='
select day_key, week_start from public.checkin_makeups
 where user_id = '00000000-0000-0000-0000-0000000000dd';
select x.day_key, x.makeup
  from jsonb_to_recordset(public.get_daily_study())
       as x(day_key date, makeup boolean)
 where x.makeup = true;

\echo ''
\echo '===== 10) 权限：daily_study_of 对 authenticated 不可调 ====='
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000dd"}', true);
do $$ begin
  perform count(*) from public.daily_study_of('00000000-0000-0000-0000-0000000000dd'::uuid);
  raise notice '  ❌ daily_study_of 竟然可被 authenticated 调用 —— 权限没收回';
exception when others then
  raise notice '  ✅ 已收口: %', sqlerrm;
end $$;

\echo ''
\echo '===== 11) 权限：get_daily_study_all 学生不可调、staff 可调 ====='
do $$ begin
  perform public.get_daily_study_all();
  raise notice '  ❌ 学生竟然调用了 get_daily_study_all';
exception when others then
  raise notice '  ✅ 学生被拒: %', sqlerrm;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"4ee6adff-8a0e-432b-b088-d452bc066154"}', true); -- chenzh (developer+teacher)
set local role authenticated;
do $$ declare v_n int; begin
  select jsonb_array_length(public.get_daily_study_all()) into v_n;
  raise notice '  ✅ staff 调用成功，返回 % 个学生', v_n;
exception when others then
  raise notice '  ❌ staff 也被拒了: %', sqlerrm;
end $$;
reset role;

\echo ''
\echo '===== 12) get_daily_study_all 的隔离：不含 staff 自己 ====='
select set_config('request.jwt.claims', '{"sub":"4ee6adff-8a0e-432b-b088-d452bc066154"}', true);
set local role authenticated;
select jsonb_path_query_array(public.get_daily_study_all(), '$[*].user_id') as user_ids;
reset role;

\echo ''
\echo '===== 测试结束，ROLLBACK（不留数据）====='
rollback;
