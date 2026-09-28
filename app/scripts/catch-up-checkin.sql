-- ============================================================================
-- 上线前补齐：把「基线之后、起算日之前」的服务端打卡记录补到与本地一致
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f app/scripts/catch-up-checkin.sql
--
-- 幂等（on conflict do update）；可重复执行，每次只补"还差的那部分"。
--
-- 回滚：delete from public.checkin_baselines where source = 'caught-up:pre-launch';
--
-- ---------------------------------------------------------------------------
-- 为什么需要
--
-- 打卡判定 2026-09-30 切到服务端（`checkin_mode`），服务端成为权威口径，
-- 而**初始补签卡的发放也按服务端口径的累计打卡**（《练级与奖励体系方案》§4.3.1 已同步改口径）。
-- 服务端历史有两个来源：基线（≤ 09-22，已导入 101 行）与事件（≥ 09-23）。
-- 事件这一段有过缺口：
--   · 09-24~09-26 的「批量入队抢跑」bug 让服务端只收到 1~2 条（已修，但缺的没回来）
--   · 学生假期未登录时，积压事件超过 72 小时窗口后客户端会主动丢弃
-- ⇒ 不补的话，服务端会**少算若干达标日**，发卡时学生明明坚持了却没被承认。
--
-- ---------------------------------------------------------------------------
-- ⚠ 三条容易搞错的地方
--
-- 1) **补的是「差值」，不是本地全值。** `daily_study_of()` 把基线与事件**相加**
--    （不是取 max），而增量会叠在已有事件上 ⇒ 写本地全值会让那天翻倍。
-- 2) **范围含「未达标日」**，不只是达标日。未达标日也要补原因有二：
--    教师端月度视图的三态显示需要它们，且连续天数的判断依赖完整日序列。
--    补它们**不会改变任何判定**（合并后仍不达标），是安全的。
-- 3) **范围不含起算日当天及以后。** 09-30 起的事件是权威来源，补基线会与它们相加。
-- ============================================================================

\echo '== 补齐范围 =='
select date '2026-09-23' as from_day, date '2026-09-29' as to_day;

\echo ''
\echo '== 写入前：待补的行（本地 > 服务端的部分）=='
with locals as (
  select s.user_id::uuid as uid,
         (kv.key)::date as day,
         (kv.value->>'questions')::int   as lq,
         (kv.value->>'seconds')::int     as ls,
         (kv.value->>'correct')::numeric as lc
    from public.student_data s
    cross join lateral jsonb_each(coalesce(s.data->'checkin'->'study', '{}'::jsonb)) kv
   where (kv.key)::date between date '2026-09-23' and date '2026-09-29'
),
merged as (
  select l.uid, l.day, l.lq, l.ls, l.lc,
         coalesce(ev.q, 0) as sq,
         coalesce(ev.ms, 0) as sms,
         coalesce(ev.c, 0) as sc
    from locals l
    left join lateral (
      select (count(*) filter (where e.kind = 'answer'))::int as q,
             coalesce(sum(e.elapsed_ms) filter (where e.kind = 'answer'), 0)::bigint as ms,
             coalesce(sum(e.score) filter (where e.kind = 'answer'), 0)::numeric as c
        from public.xp_events e
       where e.user_id = l.uid and e.day_key = l.day
    ) ev on true
)
select left(uid::text, 8) as uid8, day::text as day,
       lq as local_q, sq as srv_q, (lq - sq) as add_q,
       ls as local_sec, (sms / 1000)::int as srv_sec,
       (ls - floor(sms / 1000.0))::int as add_sec,
       (lc - sc) as add_correct
  from merged
 where (lq - sq) > 0 or (ls - floor(sms / 1000.0)) > 0
 order by day, uid8;

\echo ''
\echo '== 写入 =='
begin;

insert into public.checkin_baselines (user_id, day_key, questions, seconds, correct, source)
select l.uid, l.day,
       greatest(0, l.lq - coalesce(ev.q, 0)),
       greatest(0, l.ls - coalesce(floor(ev.ms / 1000.0), 0)::int),
       greatest(0, l.lc - coalesce(ev.c, 0)),
       'caught-up:pre-launch'
  from (
    select s.user_id::uuid as uid,
           (kv.key)::date as day,
           (kv.value->>'questions')::int   as lq,
           (kv.value->>'seconds')::int     as ls,
           (kv.value->>'correct')::numeric as lc
      from public.student_data s
      cross join lateral jsonb_each(coalesce(s.data->'checkin'->'study', '{}'::jsonb)) kv
     where (kv.key)::date between date '2026-09-23' and date '2026-09-29'
  ) l
  left join lateral (
    select (count(*) filter (where e.kind = 'answer'))::int as q,
           coalesce(sum(e.elapsed_ms) filter (where e.kind = 'answer'), 0)::bigint as ms,
           coalesce(sum(e.score) filter (where e.kind = 'answer'), 0)::numeric as c
      from public.xp_events e
     where e.user_id = l.uid and e.day_key = l.day
  ) ev on true
 where (l.lq - coalesce(ev.q, 0)) > 0
    or (l.ls - coalesce(floor(ev.ms / 1000.0), 0)::int) > 0
on conflict (user_id, day_key) do update
   set questions = excluded.questions,
       seconds   = excluded.seconds,
       correct   = excluded.correct,
       source    = excluded.source;

commit;

\echo ''
\echo '== 写入后：合并结果应等于本地（差值为 0 的行才是对的）=='
with locals as (
  select s.user_id::uuid as uid,
         (kv.key)::date as day,
         (kv.value->>'questions')::int as lq,
         (kv.value->>'seconds')::int   as ls
    from public.student_data s
    cross join lateral jsonb_each(coalesce(s.data->'checkin'->'study', '{}'::jsonb)) kv
   where (kv.key)::date between date '2026-09-23' and date '2026-09-29'
)
select count(*) filter (where d.questions <> l.lq) as q_mismatch,
       count(*) filter (where (d.ms / 1000)::int <> l.ls) as sec_mismatch,
       count(*) as rows_checked
  from locals l
  join lateral (select * from public.daily_study_of(l.uid, l.day, l.day)) d on true;

\echo ''
\echo '== checkin_baselines 现状 =='
select source, count(*) as rows, min(day_key) as earliest, max(day_key) as latest
  from public.checkin_baselines
 group by source
 order by source;
