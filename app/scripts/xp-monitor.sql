-- ============================================================================
-- XP 假期监控（**只读**，随时可跑）
--
-- 用途：假期学生高强度使用时，用一页输出回答三个问题 ——
--   ① 上报在正常进来吗？（行数 / 学生数 / 按天）
--   ② 有没有被误标异常？（suspicious —— 尤其批量题型的均摊用时）
--   ③ **有没有学生「本地练了但服务端没收到」？**（最要紧的一条）
--
-- 用法：
--   psql -h <host> -p 5432 -U postgres -d postgres -A -F ' | ' -t \
--        -f scripts/xp-monitor.sql
--
-- ⚠ 本库是 AnalyticDB for PostgreSQL 兼容版：**没有 `jsonb_object_length()`**，
--   要数 jsonb 对象键数时用 `(select count(*) from jsonb_object_keys(x))`。
-- ⚠ 全部只读，不改任何数据。
-- ⚠ 上线日若变更，改下面这一处常量即可（基线覆盖 < 该日，事件覆盖 >= 该日）。
-- ============================================================================

\echo ''
\echo '========== ① 总览 =========='
select concat('events=', count(*)::text,
              '  students=', count(distinct user_id)::text,
              '  days=', coalesce(min(day_key)::text, '-'), ' .. ', coalesce(max(day_key)::text, '-'),
              '  total_xp=', coalesce(sum(xp), 0)::text,
              '  suspicious=', count(*) filter (where suspicious)::text) as overview
  from public.xp_events;

\echo ''
\echo '========== ② 按天（题数 / XP / 学生数 / 可疑数 / 打满 400 后记 0 的条数）=========='
select day_key::text,
       count(*) filter (where kind = 'answer')            as questions,
       coalesce(sum(xp), 0)                               as xp_total,
       count(distinct user_id)                            as students,
       count(*) filter (where suspicious)                 as susp,
       count(*) filter (where xp = 0 and kind = 'answer') as capped_zero
  from public.xp_events
 group by day_key
 order by day_key desc
 limit 15;

\echo ''
\echo '========== ③ 按题型分布（看假期实际在练什么）=========='
select mode, kind,
       count(*)::text                as n,
       count(distinct user_id)::text as students,
       coalesce(sum(xp), 0)::text    as xp_total
  from public.xp_events
 group by mode, kind
 order by count(*) desc;

\echo ''
\echo '========== ④ 覆盖率（分母 = 有历史基线的真实学生，已排除教职工）=========='
select concat('baseline_students=', count(distinct user_id)::text) as baseline
  from public.checkin_baselines;
select concat('students_with_events=', count(distinct user_id)::text) as with_events
  from public.xp_events;

\echo ''
\echo '========== ⑤ ⚠ 最要紧：本地有练习、服务端当天却无事件的日子（上报可疑）=========='
-- 大量出现 ⇒ 客户端上报链路有问题，或该生是游客（游客本就不入服务端，见方案裁决）。
-- ⚠ 只查上线日之后；基线日（< 上线日）本地有、服务端本来就没有，不算问题。
select s.user_id::text                        as user_id,
       kv.key                                 as day_key,
       (kv.value->>'questions')               as local_questions,
       (kv.value->>'seconds')                 as local_seconds
  from public.student_data s
  cross join lateral jsonb_each(coalesce(s.data->'checkin'->'study', '{}'::jsonb)) kv
 where kv.key >= '2026-09-23'          -- ← 上线日（改这里）
   and not exists (
     select 1
       from public.xp_events e
      where e.user_id = s.user_id::uuid
        and e.day_key::text = kv.key)
 order by kv.key desc, s.user_id
 limit 30;

\echo ''
\echo '========== ⑥ 可疑事件明细（同一批 elapsed_ms 全同且 <=500ms）=========='
select left(user_id::text, 8)                 as uid8,
       day_key::text, mode, item_id,
       coalesce(elapsed_ms::text, 'NULL')     as ms,
       xp::text, received_at::text
  from public.xp_events
 where suspicious
 order by received_at desc
 limit 20;

\echo ''
\echo '========== ⑦ 用时分布（刷分会表现为极小用时；NULL = 客户端没报用时）=========='
select concat('min=', coalesce(min(elapsed_ms), 0)::text,
              '  max=', coalesce(max(elapsed_ms), 0)::text,
              '  avg=', coalesce(round(avg(elapsed_ms)), 0)::text,
              '  null_count=', count(*) filter (where elapsed_ms is null)::text,
              '  under_1s=', count(*) filter (where elapsed_ms < 1000)::text) as timing
  from public.xp_events
 where kind = 'answer';

\echo ''
\echo '========== ⑧ 每日事件数（某天骤降为 0 而前后有值 ⇒ 上报断档，值得看一眼）=========='
select day_key::text, count(*)::text as events, count(distinct user_id)::text as students
  from public.xp_events
 group by day_key
 order by day_key desc
 limit 10;
