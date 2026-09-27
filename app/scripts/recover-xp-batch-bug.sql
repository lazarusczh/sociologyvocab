-- ============================================================================
-- 回填：XP 队列「批量入队抢跑」bug 造成的服务端缺口（2026-09-24 ~ 2026-09-26）
--
-- 用法：
--   psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f scripts/recover-xp-batch-bug.sql
--
-- 背景：2026-09-24 上线的版本把 readQueue() 提到了 await getSession() 之前，
--   而 QuizTaker 交卷时在一个同步循环里记录整份作业（约 20 个词条）⇒
--   第 1 次调用触发的 flush 只读到队列里那 1 条，其余 19 条要等 15 秒节流 /
--   60 秒心跳，而学生交卷后立刻离开 ⇒ 服务端只收到 1~2 条。
--   09-26 15:12 已上线修复（1.8.22/75）。
--
-- 为什么回填：受影响学生**本地打卡其实是达标的**（本地记录没丢），
--   但服务端那份不完整。第④步「判定切服务端」后回看历史会显示「未达标」，
--   而 9 月打卡情况要用于发放初始补签卡 ⇒ 不补则不公平。
--
-- ⚠ 关键口径：daily_study_of() 里基线(bl)与事件(ev)是**相加**（第 142~144 行
--   `coalesce(e.questions,0) + coalesce(b.questions,0)`），**不是取 max**。
--   ⇒ 基线行必须填「本地值 − 已入库事件值」这个**差值**，
--     否则合并后题数会超过本地值。
--
-- ⚠ 为什么用 checkin_baselines 而不是 apply_makeup：
--   ① 它本身就是「每日达标记录」的形态（questions / seconds / correct）；
--   ② daily_study_of() 已把它当第一源合并 ⇒ 判定自动正确，零函数改动；
--   ③ 没有 unique(user_id, week_start) 那种「一周一次」限制；
--   ④ correct 可如实填（apply_makeup 那条路根本不经手数值）。
--
-- 幂等：on conflict (user_id, day_key) do update ⇒ 可重复执行。
-- 回滚：delete from public.checkin_baselines
--        where source = 'recovered:xp-queue-batch-bug';
--
-- ⚠⚠ 后续注意：import-baselines.sql 用 `kv.key < launch_day` 框定范围。
--   这 4 行的 day_key 是 09-25 / 09-26，只要**重跑导入时 launch_day 保持
--   2026-09-23**（或更早）就不会被覆盖。若将来用更晚的 launch_day 重导，
--   这 4 行会被本地全值覆盖，合并后变成「本地 + 事件」= 多算 1~2 题。
-- ============================================================================

\echo '== ① 加 source 列（幂等；原 101 行取默认 import）=='
alter table public.checkin_baselines
  add column if not exists source text not null default 'import';

\echo ''
\echo '== ② 候选行预览（条件：本地达标 且 服务端未达标）=='
with cand as (
  select s.user_id, (kv.key)::date as day_key,
         (kv.value->>'questions')::int    as lq,
         (kv.value->>'seconds')::int      as ls,
         (kv.value->>'correct')::numeric  as lc,
         coalesce(ev.n, 0) as eq, coalesce(ev.ms, 0) as ems, coalesce(ev.score, 0) as escore
    from public.student_data s
    cross join lateral jsonb_each(coalesce(s.data->'checkin'->'study', '{}'::jsonb)) kv
    left join lateral (
      select (count(*) filter (where e.kind = 'answer'))::int as n,
             coalesce(sum(e.elapsed_ms) filter (where e.kind = 'answer'), 0)::bigint as ms,
             coalesce(sum(e.score) filter (where e.kind = 'answer'), 0)::numeric as score
        from public.xp_events e
       where e.user_id = s.user_id::uuid          -- ⚠ student_data.user_id 是 text
         and e.day_key = (kv.key)::date
    ) ev on true
   where (kv.key)::date between '2026-09-24' and '2026-09-26'
     and (kv.value->>'questions')::int >= 20      -- 本地题数达标
     and (kv.value->>'seconds')::int   >= 600     -- 本地时长达标
     and (coalesce(ev.n, 0) < 20 or coalesce(ev.ms, 0) < 600000)  -- 服务端未达标
)
select left(user_id::text, 8) as uid8, day_key::text as day,
       lq as L_q, ls as L_sec, lc as L_corr,
       eq as E_q, (ems / 1000)::int as E_sec, escore as E_corr,
       (lq - eq) as ADD_q,
       (ls - floor(ems / 1000.0))::int as ADD_sec,
       (lc - escore) as ADD_corr
  from cand order by day, uid8;

\echo ''
\echo '== ③ 写入（差值行）=='
begin;

insert into public.checkin_baselines (user_id, day_key, questions, seconds, correct, source)
select s.user_id::uuid,
       (kv.key)::date,
       (kv.value->>'questions')::int    - coalesce(ev.n, 0),
       (kv.value->>'seconds')::int      - coalesce(floor(ev.ms / 1000.0), 0)::int,
       (kv.value->>'correct')::numeric  - coalesce(ev.score, 0),
       'recovered:xp-queue-batch-bug'
  from public.student_data s
  cross join lateral jsonb_each(coalesce(s.data->'checkin'->'study', '{}'::jsonb)) kv
  left join lateral (
    select (count(*) filter (where e.kind = 'answer'))::int as n,
           coalesce(sum(e.elapsed_ms) filter (where e.kind = 'answer'), 0)::bigint as ms,
           coalesce(sum(e.score) filter (where e.kind = 'answer'), 0)::numeric as score
      from public.xp_events e
     where e.user_id = s.user_id::uuid
       and e.day_key = (kv.key)::date
  ) ev on true
 where (kv.key)::date between '2026-09-24' and '2026-09-26'
   and (kv.value->>'questions')::int >= 20
   and (kv.value->>'seconds')::int   >= 600
   and (coalesce(ev.n, 0) < 20 or coalesce(ev.ms, 0) < 600000)
on conflict (user_id, day_key) do update
   set questions = excluded.questions,
       seconds   = excluded.seconds,
       correct   = excluded.correct,
       source    = excluded.source;

commit;

\echo ''
\echo '== ④ 验证：合并后（基线 + 事件）应等于本地值 =='
with locals as (
  select s.user_id::uuid as user_id, (kv.key)::date as day_key,   -- ⚠ student_data.user_id 是 text
         (kv.value->>'questions')::int as lq, (kv.value->>'seconds')::int as ls
    from public.student_data s
    cross join lateral jsonb_each(coalesce(s.data->'checkin'->'study', '{}'::jsonb)) kv
   where left(s.user_id::text, 8) in (
           select left(user_id::text, 8) from public.checkin_baselines
            where source = 'recovered:xp-queue-batch-bug')
     and (kv.key)::date between '2026-09-24' and '2026-09-26'
)
select left(l.user_id::text, 8) as uid8, l.day_key::text as day,
       l.lq as L_q, l.ls as L_sec,
       d.questions as MERGED_q, (d.ms / 1000)::int as MERGED_sec,
       (d.questions >= 20 and d.ms >= 600000) as ok
  from locals l
  join lateral (select * from public.daily_study_of(l.user_id, l.day_key, l.day_key)) d on true
 order by l.day_key, uid8;

\echo ''
\echo '== ⑤ checkin_baselines 现状 =='
select source, count(*) as rows, min(day_key) as earliest, max(day_key) as latest
  from public.checkin_baselines group by source order by source;
