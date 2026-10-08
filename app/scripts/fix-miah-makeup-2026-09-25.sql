-- ============================================================================
-- 补记 Miah Jin（ad73a029）2026-09-25 的打卡（2026-10-08 教师决定）
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f app/scripts/fix-miah-makeup-2026-09-25.sql
--
-- 回滚：delete from public.checkin_baselines where source = 'fix:makeup-2026-09-25';
--
-- 幂等：on conflict (user_id, day_key) do update ⇒ 可重复执行。
--
-- ---------------------------------------------------------------------------
-- 为什么要补
--
-- 她的**本地**打卡记录里 09-25 是一次补签（旧规则「当周机会」），
-- 而服务端 `checkin_makeups` 只有 09-02 / 09-09 两条。原因：上线前的补签迁移
-- **只覆盖到 09-22**（`checkin_baselines` 的 `import` 批次范围就是 08-24 ~ 09-22），
-- 而 09-25 落在 09-23 ~ 09-28 的「补齐基线」窗口里 —— 那一批只搬了每日练习基线、
-- **没有搬补签**。所以她的 09-25 只存在于本机。
--
-- 影响面：**只有她一个** —— 全库 18 名学生里，只有她有本地补签。
--
-- ---------------------------------------------------------------------------
-- ⚠⚠ 为什么用 `checkin_baselines` 而**不是** `checkin_makeups`
--
-- `get_card_balance()` 的余额公式是：
--     v_makeup := count(card_grants kind='makeup') − count(checkin_makeups)
-- 即 **`checkin_makeups` 的每一行都被算作花掉一张补签卡** ⇒ 往那里插一行会
-- **倒扣她一张卡**；而她当年用的是「当周免费机会」，本就不该扣卡。
-- 且那张表**没有来源列**：插进去既不能审计、也不能只回滚这一条。
--
-- 基线表则刚好合适 —— `daily_study_of()` 的合并方式是：
--     questions = ev.questions + bl.questions
--     ms        = ev.ms        + bl.seconds * 1000
--     correct   = ev.correct   + bl.correct
-- 该日**没有任何事件**，所以这一行就是那天的全部来源。
--
-- ---------------------------------------------------------------------------
-- ⚠⚠ `correct = 16` 不是随手写的（这是本脚本唯一需要动脑的数字）
--
-- 补记会进第 **2026-09-21** 周，而周卡判据是 `w.q >= 100 且 (w.c / w.q) >= 0.8`。
-- 她那一周原本是 **173 题 / 141 分 = 81.50%** —— 只比门槛高 1.5 个点。
-- 若按直觉写 `correct = 0`，就变成 193 / 141 = **73.1%**，**掉出 80%**：
-- 万一将来重算卡（`grant_pending_cards()` 是按当时数据现算的），她会丢一张周卡。
-- 取 **16** 使周正确率停在 **81.35%**，与原来几乎相同 ⇒ **不改变任何既有权益**。
--
-- 已在回滚事务里验证过（见提交说明）：
--   卡集合逐条不变（7 张：5 legacy + week:2026-09-14 + week:2026-09-21）
--   累计达标 14 → 15、最长连续仍 5
-- ============================================================================
\set ON_ERROR_STOP on

\echo '== 0) 写入前：她 09-25 是否已有基线行（首次执行应为 0 行）=='
select count(*) as existing_rows
  from public.checkin_baselines b
  join public.student_data s on s.user_id::uuid = b.user_id
 where s.data->>'name' = 'Miah Jin' and b.day_key = date '2026-09-25';

\echo ''
\echo '== 1) 写入 =='
insert into public.checkin_baselines (user_id, day_key, questions, seconds, correct, source)
select s.user_id::uuid, date '2026-09-25', 20, 600, 16, 'fix:makeup-2026-09-25'
  from public.student_data s
 where s.data->>'name' = 'Miah Jin'
on conflict (user_id, day_key) do update
  set questions = excluded.questions,
      seconds   = excluded.seconds,
      correct   = excluded.correct,
      source    = excluded.source;

\echo ''
\echo '== 2) 复核：该日是否达标（now_checked 必须为 t）=='
select b.day_key::text as day, b.questions as add_q, b.seconds as add_sec,
       b.correct as add_c, b.source,
       (d.makeup or (d.questions >= 20 and d.ms >= 600000)) as now_checked,
       d.questions as merged_q, round(d.ms / 1000.0) as merged_sec
  from public.checkin_baselines b
  join public.student_data s on s.user_id::uuid = b.user_id
  cross join lateral public.daily_study_of(b.user_id, date '2026-09-25', date '2026-09-25') d
 where s.data->>'name' = 'Miah Jin' and b.day_key = date '2026-09-25';

\echo ''
\echo '== 3) 复核：累计达标 / 最长连续（应为 15 / 5）=='
with t as (select user_id::uuid as uid from public.student_data where data->>'name' = 'Miah Jin'),
     c as (select d.day_key from t, lateral public.daily_study_of(t.uid, null, null) d
            where d.makeup or (d.questions >= 20 and d.ms >= 600000)),
     g as (select day_key, day_key - (row_number() over (order by day_key))::int as grp from c)
select (select count(*) from c) as accum_days,
       (select max(n) from (select count(*) as n from g group by grp) t2) as best;

\echo ''
\echo '== 4) 复核：本次写入不碰卡（card_grants 行数应与写入前一致）=='
select count(*) as card_grants_total from public.card_grants;
