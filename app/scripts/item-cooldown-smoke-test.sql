-- ============================================================================
-- 「同题去重」门槛冒烟测试 —— **全程回滚**
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f app/scripts/item-cooldown-smoke-test.sql
--
-- 验证规则（2026-10-08 教师裁定抬高门槛后）：
--   同一 `item_id` 在 **60 秒内**前 5 条**收**，第 6 条起才记 `same_item_too_soon`。
--   旧规则是「存在一条就拒收」—— 日常练习是随机抽题，重复同一题号是正常的，
--   而旧门槛会**整条丢弃**，连打卡题数一起少算（实测假期 9 天少 1~2 题）。
--
-- ⚠ 只发 kind='answer' 且 elapsed_ms 全为 5000：避开函数里那条
--   「一批用时全同且 <=500ms」的防刷检查，否则会先被它拦掉、测不到本规则。
-- ============================================================================

begin;

\echo '== 0) 挑一个学生并冒充（不写死 uid）=='
select s.user_id::uuid as student_uid
  from public.student_data s
 where not exists (select 1 from public.user_roles r
                    where r.user_id = s.user_id::uuid and r.role in ('teacher', 'developer'))
 order by s.user_id
 limit 1 \gset
select set_config('request.jwt.claims',
                  json_build_object('sub', :'student_uid', 'role', 'authenticated')::text,
                  false); 
set role authenticated;

\echo ''
\echo '== 1) 同一题号连发 6 条（同一时刻）=> 期望 accepted=5，rejected 里 1 条 same_item_too_soon =='
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
           'event_id', gen_random_uuid(),
           'kind', 'answer',
           'item_id', '__cooldown_test_A__',
           'mode', 'choice',
           'correct', true,
           'score', 1,
           'elapsed_ms', 5000,
           'answered_at', now(),
           'session_id', null))
    from generate_series(1, 6)
));

\echo ''
\echo '== 2) 换一个题号连发 5 条 => 期望 accepted=5（新题号不受任何限制）=='
select public.submit_xp_events((
  select jsonb_agg(jsonb_build_object(
           'event_id', gen_random_uuid(),
           'kind', 'answer',
           'item_id', '__cooldown_test_B__',
           'mode', 'choice',
           'correct', true,
           'score', 1,
           'elapsed_ms', 5000,
           'answered_at', now(),
           'session_id', null))
    from generate_series(1, 5)
));

\echo ''
\echo '== 3) 再发第 7 条（同题号）=> 期望仍被拒（累计已超 5）=='
select public.submit_xp_events(jsonb_build_array(jsonb_build_object(
         'event_id', gen_random_uuid(),
         'kind', 'answer',
         'item_id', '__cooldown_test_A__',
         'mode', 'choice',
         'correct', true,
         'score', 1,
         'elapsed_ms', 5000,
         'answered_at', now(),
         'session_id', null)));

reset role;

\echo ''
\echo '== 4) 回滚（测试事件不应留下）=='
rollback;

\echo ''
\echo '== 5) 复核：测试题号应无残留 =='
select count(*) as leftover_test_events
  from public.xp_events
 where item_id like '__cooldown_test_%';
