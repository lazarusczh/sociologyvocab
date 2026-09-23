-- XP-C 冒烟测试：逐条验证 9 道防线 + 两个出口 RPC
-- 全程在一个事务里，最后 ROLLBACK —— **不留任何测试数据**。
\set ON_ERROR_STOP on
\pset pager off
\timing off

begin;

-- 模拟一个已登录学生（Supabase 的 auth.uid() 读 request.jwt.claims 的 sub）
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000aa"}', true) as jwt_set;

\echo ''
\echo '===== 1) 正常上报 3 条（choice / spelling / definition）====='
select jsonb_pretty(public.submit_xp_events('[
  {"event_id":"11111111-1111-1111-1111-111111111111","kind":"answer","item_id":"it-choice","mode":"choice",     "correct":true, "score":1,   "elapsed_ms":5000,"answered_at":"2026-09-23T10:00:00+08:00"},
  {"event_id":"22222222-2222-2222-2222-222222222222","kind":"answer","item_id":"it-spell", "mode":"spelling",   "correct":true, "score":1,   "elapsed_ms":9000,"answered_at":"2026-09-23T10:01:00+08:00"},
  {"event_id":"33333333-3333-3333-3333-333333333333","kind":"answer","item_id":"it-def",   "mode":"definition", "correct":false,"score":0.5, "elapsed_ms":60000,"answered_at":"2026-09-23T10:02:00+08:00"}
]'::jsonb));

\echo '--- 落库结果（xp 应为 4 / 8 / 5，day_key 应为 2026-09-23）---'
select event_id, mode, score, elapsed_ms, xp, day_key, suspicious
  from public.xp_events where user_id = '00000000-0000-0000-0000-0000000000aa' order by answered_at;

\echo ''
\echo '===== 2) 幂等：把上面第 1 条原样再报一次（应记 duplicated=1，不新增行）====='
select jsonb_pretty(public.submit_xp_events('[
  {"event_id":"11111111-1111-1111-1111-111111111111","kind":"answer","item_id":"it-choice","mode":"choice","correct":true,"score":1,"elapsed_ms":5000,"answered_at":"2026-09-23T10:00:00+08:00"}
]'::jsonb));
select count(*) as total_rows_should_be_3 from public.xp_events where user_id = '00000000-0000-0000-0000-0000000000aa';

\echo ''
\echo '===== 3) 防线 #3 模式白名单（bad_mode 应被拒）====='
select jsonb_pretty(public.submit_xp_events('[
  {"event_id":"44444444-4444-4444-4444-444444444444","kind":"answer","item_id":"it-x","mode":"flashcard","correct":true,"score":1,"elapsed_ms":5000,"answered_at":"2026-09-23T10:03:00+08:00"}
]'::jsonb));

\echo ''
\echo '===== 4) 防线 #2 补报窗口（未来 / 太旧，应分别被拒）====='
select jsonb_pretty(public.submit_xp_events('[
  {"event_id":"55555555-5555-5555-5555-555555555555","kind":"answer","item_id":"it-f1","mode":"choice","correct":true,"score":1,"elapsed_ms":5000,"answered_at":"2027-01-01T10:00:00+08:00"},
  {"event_id":"66666666-6666-6666-6666-666666666666","kind":"answer","item_id":"it-f2","mode":"choice","correct":true,"score":1,"elapsed_ms":5000,"answered_at":"2026-09-01T10:00:00+08:00"}
]'::jsonb));

\echo ''
\echo '===== 5) 防线 #4 用时下限：只截断不拒收（elapsed_ms=100 应记 500）====='
select jsonb_pretty(public.submit_xp_events('[
  {"event_id":"77777777-7777-7777-7777-777777777777","kind":"answer","item_id":"it-fast","mode":"choice","correct":true,"score":1,"elapsed_ms":100,"answered_at":"2026-09-23T10:04:00+08:00"}
]'::jsonb));
select item_id, elapsed_ms as ms_should_be_500, xp as xp_should_be_4 from public.xp_events where event_id = '77777777-7777-7777-7777-777777777777';

\echo ''
\echo '===== 6) 防线 #4b elapsed_ms 完全缺失：事件仍收、时长记 NULL ====='
select jsonb_pretty(public.submit_xp_events('[
  {"event_id":"88888888-8888-8888-8888-888888888888","kind":"answer","item_id":"it-noms","mode":"choice","correct":true,"score":1,"answered_at":"2026-09-23T10:05:00+08:00"}
]'::jsonb));
select item_id, elapsed_ms as ms_should_be_null, xp as xp_should_be_4 from public.xp_events where event_id = '88888888-8888-8888-8888-888888888888';

\echo ''
\echo '===== 7) 防线 #5 同题 60 秒内去重（同 item 再报一次应被拒）====='
select jsonb_pretty(public.submit_xp_events('[
  {"event_id":"99999999-9999-9999-9999-999999999999","kind":"answer","item_id":"it-choice","mode":"choice","correct":true,"score":1,"elapsed_ms":5000,"answered_at":"2026-09-23T10:00:30+08:00"}
]'::jsonb));

\echo ''
\echo '===== 8) 接龙的 answer 步不给 XP（mode=chain，应记 0），chain_complete 才结算 ====='
select jsonb_pretty(public.submit_xp_events('[
  {"event_id":"aaaaaaaa-0000-0000-0000-000000000001","kind":"answer","item_id":"ch-step","mode":"chain","correct":true,"score":1,"elapsed_ms":3000,"answered_at":"2026-09-23T11:00:00+08:00","session_id":"bbbbbbbb-0000-0000-0000-000000000001"},
  {"event_id":"aaaaaaaa-0000-0000-0000-000000000002","kind":"chain_complete","item_id":"ch-open","mode":"chain","correct":true,"score":1,"answered_at":"2026-09-23T11:02:00+08:00","session_id":"bbbbbbbb-0000-0000-0000-000000000001","chain_mode":"open","chain_kind":"input"}
]'::jsonb));
select kind, mode, chain_mode, chain_kind, xp from public.xp_events
 where user_id = '00000000-0000-0000-0000-0000000000aa' and mode = 'chain' order by answered_at;

\echo ''
\echo '===== 9) 防线 #6 同一 session 的 chain_complete 再来一次（应记 duplicated）====='
select jsonb_pretty(public.submit_xp_events('[
  {"event_id":"aaaaaaaa-0000-0000-0000-000000000003","kind":"chain_complete","item_id":"ch-open","mode":"chain","correct":true,"score":1,"answered_at":"2026-09-23T11:03:00+08:00","session_id":"bbbbbbbb-0000-0000-0000-000000000001","chain_mode":"open","chain_kind":"input"}
]'::jsonb));

\echo ''
\echo '===== 10) 防线 #9 异常标记：一批 >3 条且 elapsed_ms 全相同 ⇒ suspicious ====='
-- 时间用「当前时刻往前推 10 分钟」这类相对时间，避免因测试跑在当天的早晨而被判 future_time
select jsonb_pretty(public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
    'event_id', ('cccccccc-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'kind','answer','item_id','sus-' || i, 'mode','choice',
    'correct',true,'score',1,'elapsed_ms',7777,
    'answered_at', now() - interval '10 minutes'))
  from generate_series(1, 4) i
)));
select count(*) as suspicious_rows_should_be_4 from public.xp_events
 where user_id = '00000000-0000-0000-0000-0000000000aa' and suspicious = true;

\echo ''
\echo '===== 11) 防线 #8 每日裁剪：灌满选择题看当日练习 XP 是否停在 400 ====='
-- 造 110 条 choice（每条 4 XP = 440），分两批（单次上限 100），分散 item 以避开同题去重
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
    'event_id', ('dddddddd-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'kind','answer','item_id','bulk-' || i, 'mode','choice',
    'correct',true,'score',1,'elapsed_ms',2000,
    'answered_at', now() - interval '5 minutes'))
  from generate_series(1, 60) i
));
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
    'event_id', ('dddddddd-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'kind','answer','item_id','bulk-' || i, 'mode','choice',
    'correct',true,'score',1,'elapsed_ms',2000,
    'answered_at', now() - interval '5 minutes'))
  from generate_series(61, 110) i
));
select
  coalesce(sum(xp), 0)                                        as day_practice_xp,
  count(*)                                                    as rows_written,
  count(*) filter (where xp = 0)                              as rows_zeroed_by_cap
from public.xp_events
where user_id = '00000000-0000-0000-0000-0000000000aa' and day_key = '2026-09-23';

\echo ''
\echo '===== 12) 出口 RPC：get_xp_summary ====='
select jsonb_pretty(public.get_xp_summary('00000000-0000-0000-0000-0000000000aa') - 'daily');
select ('daily 天数 = ' || jsonb_array_length((public.get_xp_summary('00000000-0000-0000-0000-0000000000aa')) -> 'daily')) as daily_days;

\echo ''
\echo '===== 13) 出口 RPC：get_daily_study（ms 只累加 kind=answer，不含 chain_complete）====='
select jsonb_pretty(public.get_daily_study('00000000-0000-0000-0000-0000000000aa'));

\echo ''
\echo '===== 14) 权限：学生读不到别人的事件（RLS 生效需真的切换 role，超级用户会绕过）====='
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000bb"}', true);
set local role authenticated;
select count(*) as should_be_0_from_other_student from public.xp_events;
reset role;

\echo ''
\echo '===== 15) 权限：非 staff 不能查别人的总 XP（应被拒；用 DO 块捕获以免中断）====='
do $$
begin
  perform public.get_xp_summary('00000000-0000-0000-0000-0000000000aa');
  raise notice '预期被拒但成功了 —— 归属校验没生效！';
exception when others then
  raise notice '  ✅ 已正确拒绝: %', sqlerrm;
end $$;

\echo ''
\echo '===== 测试结束，ROLLBACK（不留数据）====='
rollback;
