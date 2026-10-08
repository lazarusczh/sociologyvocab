-- ============================================================================
-- 打卡记录回填：2026-10 假期「本地假通过」的 12 个「学生-天」（2026-10-08 教师裁定全部回填）
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f app/scripts/backfill-local-ui-2026-10.sql
--
-- 回滚：delete from public.checkin_baselines where source = 'fix:local-ui-2026-10';
--
-- 幂等，可重复执行（on conflict 覆盖）。⚠ 每次执行都**从 `xp_events` 现算缺额**，
--   所以之后再跑一次也安全 —— 见下面那条 ceil 的说明。
--
-- ---------------------------------------------------------------------------
-- 为什么要回填
--
-- 首页的「今日目标」卡当时读的是**本地**记录（`Home.tsx`，已于同日修复），
-- 本地按**墙钟**累计（练习组件挂着就每 10 秒 +1，含题间空闲与离开页面），
-- 服务端按**每题作答区间之和** —— 两侧口径不同，于是学生看到「今日已达成」就收工，
-- 而服务端判不达标。**这是代码不完善导致学生被误判，不能让学生承担。**
-- 清单与逐案证据见 `打卡假通过-人工查验.md`。
--
-- ---------------------------------------------------------------------------
-- ⚠⚠ 为什么用**基线表的秒数差额行**，而不是补签表
--
-- `get_card_balance()` 的余额公式是：
--     v_makeup := count(card_grants kind='makeup') − count(checkin_makeups)
-- 即 **`checkin_makeups` 的每一行都被算作花掉一张补签卡** ⇒ 往那里插 12 行会
-- **顺带扣掉学生 12 张补签卡**；而且那张表**没有来源列**，插进去与学生自己补签的
-- 无法区分，既不能审计也不能只回滚这一批。
--
-- 基线表则刚好合适 —— `daily_study_of()` 的合并方式是：
--     questions = ev.questions + bl.questions
--     ms        = ev.ms        + bl.seconds * 1000
--     correct   = ev.correct   + bl.correct
-- ⇒ 只补「秒数差额」（questions/correct 写 0）就能把那天抬过 600 秒线，而
--   周题数、周正确率（影响每周补签卡）、**卡余额**、XP **全都不变**，且 `source` 可标注。
--
-- ---------------------------------------------------------------------------
-- ⚠⚠ **缺额必须用 `ceil` 向上取整，不能用整数除法**（2026-10-08 第一次执行时踩到）
--
-- 第一次写成 `(600000 - ms) / 1000`（整数除法，**截断**）：服务端实际是 510.5 秒时
-- 算出 89 秒，合并后 = **599.5 秒**，依旧 < 600 ⇒ **11 天补了等于没补**。
-- 正确写法：`ceil((600000 - ms) / 1000.0)`。本脚本改为**从 `xp_events` 现算**缺额，
-- 而不是把数字硬编码 —— 硬编码的数字无法在下次重跑时自我纠正。
--
-- ⚠ 两类缺额分别处理（下面用 `case` 一次算完）：
--   · 缺**秒数**（11 天）⇒ questions=0, seconds=ceil(缺额)
--   · 缺**题数**（1 天：Candice 10-07，服务端只收到 18 题）⇒ questions=20-q, seconds=0
--     那 2 题是被「同题 60 秒冷却」误拒的正常作答（该门槛同日已抬高到 5 次），理应计回。
--
-- ⚠ 这一步**有意例外**于「09-30 起不得再补基线」那条规矩：那条规矩防的是**重复计数**
--   （基线与事件相加），而这里是**差额补足**（加到刚好过线），且带独立 `source` 便于整批回滚。
--   该例外已由教师明确认可。
-- ============================================================================

\echo '== 0) 回填前：本批已有的固定行数（首次执行应为 0）=='
select count(*) as existing_fix_rows,
       coalesce(sum(seconds), 0) as existing_fix_seconds
  from public.checkin_baselines
 where source = 'fix:local-ui-2026-10';

\echo ''
\echo '== 1) 写入（缺额现算；幂等，可重复执行）=='
begin;

with ev as (
  select e.user_id, e.day_key,
         (count(*) filter (where e.kind = 'answer'))::int                       as q,
         coalesce(sum(e.elapsed_ms) filter (where e.kind = 'answer'), 0)::bigint as ms
    from public.xp_events e
   where e.day_key between date '2026-10-01' and date '2026-10-08'
   group by 1, 2
),
targets(uid, day) as (
  values
    ('01ab5e09-1489-4ba0-8e22-e13097d676c8'::uuid, '2026-10-01'::date),
    ('447a1d26-34a0-479c-a4c8-38610fab69d3'::uuid, '2026-10-02'::date),
    ('2cc88743-34eb-4ff5-a9e7-2f2cb68ab239'::uuid, '2026-10-03'::date),
    ('447a1d26-34a0-479c-a4c8-38610fab69d3'::uuid, '2026-10-03'::date),
    ('447a1d26-34a0-479c-a4c8-38610fab69d3'::uuid, '2026-10-04'::date),
    ('e5bf3777-8caf-4fd8-9a80-fa29623faaa7'::uuid, '2026-10-04'::date),
    ('447a1d26-34a0-479c-a4c8-38610fab69d3'::uuid, '2026-10-05'::date),
    ('84bb93ff-90b9-4cdf-91bb-82f593ebb6aa'::uuid, '2026-10-05'::date),
    ('e370b5cf-0269-405e-b0e2-9f9c3bee7645'::uuid, '2026-10-05'::date),
    ('e5bf3777-8caf-4fd8-9a80-fa29623faaa7'::uuid, '2026-10-06'::date),
    ('e370b5cf-0269-405e-b0e2-9f9c3bee7645'::uuid, '2026-10-07'::date),
    ('e5bf3777-8caf-4fd8-9a80-fa29623faaa7'::uuid, '2026-10-07'::date)
),
calc as (
  select t.uid, t.day,
         case when coalesce(ev.q, 0) < 20 then (20 - coalesce(ev.q, 0))::int else 0 end as add_q,
         -- ⚠ ceil 向上取整：整数除法会截断，合并后停在 599.x 秒、依旧不达标
         case when coalesce(ev.q, 0) < 20 then 0
              else ceil((600000 - coalesce(ev.ms, 0)) / 1000.0)::int end                 as add_sec
    from targets t
    left join ev on ev.user_id = t.uid and ev.day_key = t.day
)
insert into public.checkin_baselines (user_id, day_key, questions, seconds, correct, source)
select c.uid, c.day, c.add_q, c.add_sec, 0, 'fix:local-ui-2026-10'
  from calc c
on conflict (user_id, day_key) do update
  set questions = excluded.questions,
      seconds   = excluded.seconds,
      correct   = excluded.correct,
      source    = excluded.source;

\echo ''
\echo '== 2) 逐条复核：这 12 天**必须全部** now_checked = t（有 f 就是没修好）=='
select left(b.user_id::text, 8) as uid8,
       to_char(b.day_key, 'MM-DD') as day,
       b.questions as add_q, b.seconds as add_sec,
       (d.makeup or (d.questions >= 20 and d.ms >= 600 * 1000)) as now_checked,
       d.questions as merged_q, (d.ms / 1000.0)::numeric(10,1) as merged_sec
  from public.checkin_baselines b
  cross join lateral public.daily_study_of(b.user_id, b.day_key, b.day_key) d
 where b.source = 'fix:local-ui-2026-10'
 order by (d.makeup or (d.questions >= 20 and d.ms >= 600 * 1000)) asc, b.day_key, uid8;

\echo ''
\echo '== 2b) 汇总（not_checked 必须为 0）=='
select count(*)::text                                                          as fix_days,
       count(*) filter (where not (d.makeup or (d.questions >= 20 and d.ms >= 600 * 1000)))::text as not_checked
  from public.checkin_baselines b
  cross join lateral public.daily_study_of(b.user_id, b.day_key, b.day_key) d
 where b.source = 'fix:local-ui-2026-10';

commit;

\echo ''
\echo '== 3) 无副作用复核：卡与 XP 都不该被这次回填影响 =='
select (select count(*) from public.checkin_makeups)  as makeups_used,
       (select sum(xp) from public.xp_events)         as total_xp,
       (select count(*) from public.xp_events)        as events,
       (select count(*) from public.card_grants)      as grants;

\echo ''
\echo '== 4) 10 月达标天数（回填后；全勤线 28 天）=='
select coalesce(nullif(st.data->>'name', ''), '(无名)')                               as name,
       count(*) filter (where d.makeup or (d.questions >= 20 and d.ms >= 600000))::text as ok_days
  from public.student_data st
  cross join lateral public.daily_study_of(st.user_id::uuid, date '2026-10-01', date '2026-10-08') d
 where not exists (select 1 from public.user_roles r
                    where r.user_id = st.user_id::uuid and r.role in ('teacher', 'developer'))
 group by 1
 order by 2 desc, 1;
