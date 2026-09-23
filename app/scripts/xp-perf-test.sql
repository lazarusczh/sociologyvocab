-- ============================================================================
-- xp_events 写入性能实测（容量评估用，2026-09-23）
--
-- 目的：回答「1C2G 的库能不能撑住服务端判别」。不做静态估算，直接计时。
--
-- ⚠ 全程在事务里，最后 rollback ⇒ **不留任何数据**。
-- ⚠ 只在生产库做**小规模**测试（一批 100 条 ≈ 一天的练习量），避免占满单核。
--
-- 用法：
--   psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f scripts/xp-perf-test.sql
-- ============================================================================

\echo ''
\echo '===== 准备：设定一个测试用 uid（末段 dd，绝不与真实学生冲突）====='

begin;

-- ⚠ set_config 的第三个参数是 is_local=true ⇒ 只在**本事务内**有效，
--   所以必须先 begin、再设置；放在 begin 之前会立刻失效，
--   submit_xp_events() 里的 auth.uid() 取到 NULL 就会报 'not authenticated'。
select set_config('request.jwt.claims',
                  '{"sub":"00000000-0000-0000-0000-0000000000dd"}', true) as jwt_set;

\echo ''
\echo '===== 1) 批量 100 条（模拟一天的练习量）耗时 ====='
\timing on
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
    'event_id',    ('eeeeeeee-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'kind',        'answer',
    'item_id',     'perf-' || i,
    'mode',        'choice',
    'correct',     true,
    'score',       1,
    'elapsed_ms',  3000,
    'answered_at', now() - interval '2 hours'))
  from generate_series(1, 100) i
)) as result_100;
\timing off

\echo ''
\echo '===== 2) 再提交 40 条（此时每日裁剪的 sum 聚合要扫前面 100 条）====='
\timing on
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
    'event_id',    ('eeeeeeee-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'kind',        'answer',
    'item_id',     'perf2-' || i,
    'mode',        'choice',
    'correct',     true,
    'score',       1,
    'elapsed_ms',  3000,
    'answered_at', now() - interval '2 hours'))
  from generate_series(101, 140) i
)) as result_140;
\timing off

\echo ''
\echo '===== 3) 幂等检查的代价：把这 100 条原样重发一次（应全部 duplicated）====='
-- ⚠ 单次上限 100 条，所以这里重发第 1 步那 100 条（不是 140 条）
\timing on
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
    'event_id',    ('eeeeeeee-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'kind',        'answer',
    'item_id',     'perf-' || i,
    'mode',        'choice',
    'correct',     true,
    'score',       1,
    'elapsed_ms',  3000,
    'answered_at', now() - interval '2 hours'))
  from generate_series(1, 100) i
)) as result_dup;
\timing off

\echo ''
\echo '===== 4) 出口 RPC：学生端总 XP ====='
\timing on
select public.get_xp_summary() -> 'total_xp' as total_xp;
\timing off

\echo ''
\echo '===== 5) 出口 RPC：逐日练习（打卡判定用）====='
\timing on
select jsonb_array_length(public.get_daily_study()) as day_count;
\timing off

\echo ''
\echo '===== 6) 全表规模（回滚前，只含本次 140 行）====='
select count(*) as matched_action_rows
  from public.xp_events
 where user_id = '00000000-0000-0000-0000-0000000000dd';

\echo ''
\echo '===== 7) 回滚（不留任何数据）====='
rollback;

\echo ''
\echo '===== 复核：回滚后 xp_events 必须为 0 行 ====='
select count(*) as xp_events_after_rollback from public.xp_events;
