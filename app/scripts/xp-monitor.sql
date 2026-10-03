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
 -- ⚠ **2026-10-03 更正**：这里原来写 `'2026-09-23'`（当时以为的上线日）。XP 起算日与判定切换日
 --   最终定在 **2026-09-30**（判定开关 09-30 23:59 生效），而 09-23~09-29 那几天已由
 --   `catch-up-checkin.sql` 的基线补齐覆盖 ⇒ 用 09-23 会把那几天**全报成"上报可疑"的假阳性**。
 --   现在分界是 09-30：**这一天起事件是唯一来源，本地有而服务端没有就是真问题**。
 where kv.key >= '2026-09-30'          -- ← 上线日（改这里）
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

\echo ''
\echo '========== ⑨ 每日达标人数（服务端口径；2026-10-03 新增）=========='
-- 达标 = 题数 >= 20 **且** 时长 >= 600 秒（或当天有补签）。
-- ⚠ 口径必须与 `grant_pending_cards()` 里的判定**完全一致**，别在别处另写一份。
-- ⚠ 09-30 起事件是权威来源（不得再补基线）⇒ 这一节的数字是纯服务端口径，不是补出来的。
\echo '  ⚠ 注意「题数够、秒数不够」是最常见的失手方式（学生做得快）——'
\echo '    本节的 checked 是硬门槛，不要把它读成"没练"。'
with d as (
  select e.user_id, e.day_key,
         count(*) filter (where e.kind = 'answer')                       as q,
         coalesce(sum(e.elapsed_ms) filter (where e.kind = 'answer'), 0)  as ms
    from public.xp_events e
   where e.day_key >= date '2026-09-30'
   group by 1, 2
)
select d.day_key::text                                      as day,
       count(*) filter (where d.q > 0)                      as students,
       count(*) filter (where d.q >= 20 and d.ms >= 600000) as checked,
       sum(d.q)::text                                       as questions,
       round(sum(d.ms) / 60000.0)::text                     as minutes
  from d
 group by 1 order by 1;

\echo ''
\echo '========== ⑩ 最近活跃（2026-10-03 新增）=========='
-- ⚠⚠ **不要用 `auth.users.last_sign_in_at` 判断"学生有没有在用"** ——
--   它只在真正「登录」时更新，**不随会话刷新更新**。学生保持登录态就永远停在旧值。
--   2026-10-03 实测：它最新只到 09-27、多数是 8 月的，而这些人假期一直在练
--   （`e370b5cf` 显示 08-30 登录，却有 93 条假期事件）⇒ 用它会得出**完全错误**的结论。
-- ⚠ 同理不要用 `student_data.updated_at`（无 trigger 维护，实际等于注册时间）。
--   **可信的活跃信号只有 `xp_events.received_at`（服务端收到的时刻）。**
select left(s.user_id::text, 8)                                                  as uid8,
       coalesce(nullif(s.data->>'name', ''), '(无名)')                           as name,
       to_char(max(e.received_at) at time zone 'Asia/Shanghai', 'MM-DD HH24:MI') as last_event_sh,
       count(e.*) filter (where e.day_key >= date '2026-09-30')                  as ev_since_launch,
       count(e.*)                                                                as ev_total
  from public.student_data s
  left join public.xp_events e on e.user_id = s.user_id::uuid
 where not exists (select 1 from public.user_roles r
                    where r.user_id = s.user_id::uuid and r.role in ('teacher', 'developer'))
 group by 1, 2
 order by max(e.received_at) desc nulls last;
