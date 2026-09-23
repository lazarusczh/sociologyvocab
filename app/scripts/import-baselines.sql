-- ============================================================================
-- 基线导入：student_data.checkin → checkin_baselines / checkin_makeups
--
-- 用法（⚠ 上线当天、学生开始练习之前执行）：
--
--   psql -h <host> -p 5432 -U postgres -d postgres \
--        -v launch_day=2026-09-25 \
--        -v ON_ERROR_STOP=1 \
--        -f scripts/import-baselines.sql
--
-- 设计依据：《XP-C档改造方案.md》§六之八。三条硬要求：
--
--   ① **`day_key < 上线日`（严格小于）** —— 新版前端**仍会写本地 checkin**
--      （`recordFormalAnswer` 未移除），上线当天会同时存在本地记录与 `xp_events`；
--      基线若含当天就是**双倍**，全勤天数失真。
--   ② **幂等（upsert，覆盖而非累加）** —— 基线源是活数据（学生到上线前一直在同步），
--      且要求「上线当天最后跑一遍」⇒ 必须可反复执行、结果一致。
--   ③ **排除教职工与测试号** —— `role in ('teacher','developer')`，
--      与 `get_daily_study_all` 的排除判据保持一致（见 §六之八）。
--
-- 本脚本**只读 `student_data`、只写两张目标表**，不修改源数据。
-- 表结构与目标表的 RLS 由 `db-migration-makeup.sql` / `db-migration-xp-c.sql` 负责。
-- ============================================================================

\pset pager off

-- 未传 launch_day 就退出，避免漏参数后把全量数据当成基线（那会把上线后的也吃进来）
\if :{?launch_day}
\else
\echo '❌ 必须传上线日：-v launch_day=YYYY-MM-DD'
\quit 1
\endif

\echo ''
\echo '============================================================'
\echo '上线日（严格小于该日的数据才会导入）与基线覆盖的末日：'
\echo '============================================================'
select :'launch_day'::date as launch_day,
       (:'launch_day'::date - 1) as baseline_last_day;

\echo ''
\echo '== 预演：本次将导入的规模（不写入）=='
select count(*)                        as study_rows,
       count(distinct s.user_id)       as study_people,
       min(kv.key)                     as earliest,
       max(kv.key)                     as latest
  from public.student_data s
  cross join lateral jsonb_each(coalesce(s.data->'checkin'->'study', '{}'::jsonb)) kv
 where kv.key < :'launch_day'
   and not exists (
     select 1 from public.user_roles r
      where r.user_id = s.user_id::uuid and r.role in ('teacher', 'developer'));

select count(*)                        as makeup_rows,
       count(distinct s.user_id)       as makeup_people
  from public.student_data s
  cross join lateral jsonb_each(coalesce(s.data->'checkin'->'makeup', '{}'::jsonb)) kv
 where kv.key < :'launch_day'
   and not exists (
     select 1 from public.user_roles r
      where r.user_id = s.user_id::uuid and r.role in ('teacher', 'developer'));

\echo ''
\echo '== 被排除的账号（应为教职工与测试号，供人工核对）=='
select s.email, string_agg(r.role, '+' order by r.role) as roles
  from public.student_data s
  join public.user_roles r on r.user_id = s.user_id::uuid
 where r.role in ('teacher', 'developer')
 group by s.email
 order by s.email;

begin;

\echo ''
\echo '== ① 导入逐日练习统计 → checkin_baselines =='
-- ⚠ `dayKey` 是浏览器本地时区字符串，与 Asia/Shanghai 一致 ⇒ **原样使用、不做二次换算**，
--   否则整体偏移一天。
insert into public.checkin_baselines (user_id, day_key, questions, seconds, correct)
select s.user_id::uuid,
       kv.key::date,
       coalesce((kv.value->>'questions')::integer, 0),
       coalesce((kv.value->>'seconds')::integer, 0),
       coalesce((kv.value->>'correct')::numeric, 0)
  from public.student_data s
  cross join lateral jsonb_each(coalesce(s.data->'checkin'->'study', '{}'::jsonb)) kv
 where kv.key < :'launch_day'
   and not exists (
     select 1 from public.user_roles r
      where r.user_id = s.user_id::uuid and r.role in ('teacher', 'developer'))
on conflict (user_id, day_key) do update      -- 幂等：重跑覆盖，不累加
  set questions = excluded.questions,
      seconds   = excluded.seconds,
      correct   = excluded.correct;

\echo '== ② 导入历史补签 → checkin_makeups =='
-- ⚠ **必须以 `makeup` 自身为准，不要用 `study` 的日期范围去框**：
--   实测有补签日（`chenzh` 2026-08-19）**早于最早的 study 记录**（08-20），
--   用 study 的范围筛会漏掉它。
--
-- `week_start` 由被补那天所在周反推（`date_trunc('week', …)::date`，即周一）。
-- 机制是「只补本周漏签日」⇒ **动作周 == 被补天所在周**，无歧义；
-- 且 `day_key` 已按 Asia/Shanghai 折算，故这里**不再做任何时区转换**。
insert into public.checkin_makeups (user_id, day_key, week_start)
select s.user_id::uuid,
       kv.key::date,
       date_trunc('week', kv.key::date)::date
  from public.student_data s
  cross join lateral jsonb_each(coalesce(s.data->'checkin'->'makeup', '{}'::jsonb)) kv
 where kv.key < :'launch_day'
   and not exists (
     select 1 from public.user_roles r
      where r.user_id = s.user_id::uuid and r.role in ('teacher', 'developer'))
on conflict (user_id, day_key) do update      -- 幂等
  set week_start = excluded.week_start;

commit;

\echo ''
\echo '== 导入后目标表现状 =='
select 'checkin_baselines' as target, count(*) as rows, min(day_key) as earliest, max(day_key) as latest
  from public.checkin_baselines
union all
select 'checkin_makeups', count(*), min(day_key), max(day_key)
  from public.checkin_makeups;

\echo ''
\echo '== 复核：基线覆盖的日期必须全部 < 上线日（应为 0 行）=='
select count(*) as rows_not_before_launch
  from public.checkin_baselines
 where day_key >= :'launch_day'::date;

\echo ''
\echo '✅ 导入完成。提醒：上线当天若仍有学生在用旧版练习，收工前再跑一遍本脚本即可（幂等）。'
