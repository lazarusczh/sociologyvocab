-- ============================================================================
-- 卡发放 v2：上线前的欠账「合计封顶 7 张」，并且只发给学生
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f db-migration-cards-v2.sql
--
-- 前置：`db-migration-cards.sql`（表与余额出口）。
--
-- ⚠⚠ **本文件必须晚于 `db-migration-cards.sql` 执行** —— 两者都创建
--    `grant_pending_cards()`，先跑 cards.sql 会把本文件的版本覆盖回旧版。
--    （与 `db-migration-makeup-v2.sql` 同理；迁移文件按序应用是约定。）
--
-- 幂等，可重复执行（函数体整体替换，不写数据）。
--
-- ---------------------------------------------------------------------------
-- 改了什么，以及为什么（2026-09-28 教师拍板）
--
-- 上线前实测初始发放分布，发现最活跃的学生拿到 **9 张**：
--   5 张来自 §4.3.1 的初始档（`legacy:accum3/7/14` + `legacy:streak3` + `legacy:makeup1`）
--   + 4 张来自**对全部历史周现算的周卡**（`week:2026-08-31 / 09-07 / 09-14 / 09-21`）。
-- 「每周达标」原本是对**全部历史**现算的，于是历史上每一个达标的周都被追溯发了一次。
--
-- 教师裁决：**保留历史周卡，但一个人的「上线前欠账」合计封顶 7 张**（9 → 7）。
--   理由是 §4.3.1 写的就是「上限 7 张」，而历史周卡与 §4.3.1 的初始档
--   **在补偿同一件事**（§4.3.1 的动机原文是「他们当时赚的补签机会…被『当周赚当周用』作废了」），
--   所以两者应当合起来受同一个上限约束，而不是各算各的。
--
-- ⚠ **封顶只作用于「上线前」，不作用于上线后**：
--   §4.3 明确写了补签卡「不过期、**不设上限**」，若把封顶做成总量上限，
--   学生往后每多达标一周就再也拿不到卡 —— 那是把一条激励链切断，不是本次要修的东西。
--   分界线取 `week_start <= 2026-09-21`：该周结束于 09-27，仍在上线日 09-30 之前。
--
-- ⚠ **等级里程碑不参与封顶**：它是长期奖励（LV10/20/25/50…），不是一次性初始发放；
--   而且 XP 起算日是 09-30，上线时人人 LV1、这一项本来也发不出东西。
--
-- **封顶时裁谁**：legacy 档**全部保留**（它是 §4.3.1 的正规初始发放、有明确阈值依据），
--   超出部分从**周卡**里裁，且**先生效最近的周**（越早的周越先被裁掉）。
--   实测最活跃者：5 张 legacy + 2 张周卡 = 7。
--
-- ---------------------------------------------------------------------------
-- 顺带修的一个缺口：角色校验
--
-- §4.3.1「实现要点」第 2 条明确要求**只发给学生** ——「教师账号通常也有打卡数据，不该参与发放」。
-- 旧版 `grant_pending_cards()` **没有这条判断**，任何人调 `get_card_balance()` 都会触发发放。
-- 实测教师/开发者**一张未得**（18 张全是学生），所以当时无实际影响，
-- 但那是靠「教师恰好没有达标历史」侥幸成立 ⇒ 现在补成结构性成立。
-- ============================================================================

create or replace function public.grant_pending_cards(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_level       integer;
  v_xp          integer;
  v_accum_days  integer;
  v_best_streak integer;
  v_makeup_days integer;
begin
  if p_uid is null then
    return;
  end if;

  -- ---------- (0) 只发给学生（§4.3.1 实现要点 2）----------
  if exists (
    select 1 from public.user_roles r
     where r.user_id = p_uid and r.role in ('teacher', 'developer')
  ) then
    return;
  end if;

  -- ---------- (1) 先算 §4.3.1 三个阈值所需的数 ----------
  -- 累计达标天数
  select count(*) into v_accum_days
    from public.daily_study_of(p_uid, null, null) d
   where d.makeup or (d.questions >= 20 and d.ms >= 600 * 1000);

  -- 历史最长连续：由日序列现算（服务端没有 bestStreak 字段，见 checkinServer.ts 的说明）
  with days as (
    select d.day_key,
           (d.makeup or (d.questions >= 20 and d.ms >= 600 * 1000)) as ok
      from public.daily_study_of(p_uid, null, null) d
  ),
  checked as (
    select d.day_key,
           d.day_key - (row_number() over (order by d.day_key))::int as grp
      from days d
     where d.ok
  ),
  runs as (select grp, count(*) as len from checked group by grp)
  select coalesce(max(len), 0) into v_best_streak from runs;

  -- 曾补签过的天数（服务端补签记录条数）
  select count(*) into v_makeup_days
    from public.checkin_makeups m where m.user_id = p_uid;

  -- 等级（只统计起算日之后，与前端同口径）
  select coalesce(sum(xp), 0) into v_xp
    from public.xp_events
   where user_id = p_uid and day_key >= date '2026-09-30';
  v_level := public.xp_level(v_xp);

  -- ---------- (2) 一次性算出全部候选，对「上线前的欠账」封顶 7 张 ----------
  -- 全部发放走同一条 insert，封顶靠 `row_number() over (partition by capped)` 实现 ——
  -- 这样「受封顶的部分」与「不受封顶的部分」在同一个语句里各自取数，
  -- 不必先插后删（那会让每次读余额都产生写churn）。
  insert into public.card_grants (user_id, kind, ref)
  with weeks as (
    select date_trunc('week', d.day_key)::date as week_start,
           sum(d.questions) as q,
           sum(d.correct)   as c
      from public.daily_study_of(p_uid, null, null) d
     group by 1
  ),
  candidates as (
    -- === A. 上线前的欠账（capped = 0，**受 7 张封顶**）===
    -- A1. §4.3.1 的初始档（阈值从严版：累计 3/7/14、连续 3/7/14、曾补签 ≥1）
    select 'makeup'::text as kind, 'legacy:accum3'::text as ref, 0 as capped, 1 as prio
     where v_accum_days >= 3
    union all select 'makeup', 'legacy:accum7',   0, 2 where v_accum_days >= 7
    union all select 'makeup', 'legacy:accum14',  0, 3 where v_accum_days >= 14
    union all select 'makeup', 'legacy:streak3',  0, 4 where v_best_streak >= 3
    union all select 'makeup', 'legacy:streak7',  0, 5 where v_best_streak >= 7
    union all select 'makeup', 'legacy:streak14', 0, 6 where v_best_streak >= 14
    union all select 'makeup', 'legacy:makeup1',  0, 7 where v_makeup_days >= 1
    -- A2. 上线前已完整结束的周（week_start <= 2026-09-21 ⇒ 该周结束于 09-27 < 09-30）
    --     prio 让**越近的周越靠前**（被挤出封顶时先裁最老的）
    union all
    select 'makeup',
           'week:' || w.week_start::text,
           0,
           2000 - (w.week_start - date '2026-01-01')
      from weeks w
     where w.week_start <= date '2026-09-21'
       and w.q >= 100 and w.q > 0 and (w.c / w.q) >= 0.8

    -- === B. 等级里程碑（capped = 1，**不受封顶**）===
    -- B1. 每 10 级：补签卡与加分卡交替（LV10 补签 → LV20 加分 → LV30 补签 …）
    union all
    select case when (g.lv / 10) % 2 = 1 then 'makeup' else 'bonus' end,
           'lv' || g.lv::text || ':decade',
           1,
           1
      from generate_series(10, v_level, 10) as g(lv)
    -- B2. 每 25 级：加分卡 ×1（叠加在上面那档之上）
    union all
    select 'bonus', 'lv' || g.lv::text || ':quarter', 1, 2
      from generate_series(25, v_level, 25) as g(lv)
    -- B3. 大节点 LV50 / 100 / 200：加分卡 ×2
    union all
    select 'bonus', 'lv' || b.n::text || ':big' || s.i::text, 1, 3
      from (values (50), (100), (200)) as b(n)
      cross join generate_series(1, 2) as s(i)
     where b.n <= v_level

    -- === C. 上线后新赚的周卡（capped = 1，**不受封顶**，§4.3「不设上限」）===
    union all
    select 'makeup',
           'week:' || w.week_start::text,
           1,
           4
      from weeks w
     where w.week_start > date '2026-09-21'
       and w.q >= 100 and w.q > 0 and (w.c / w.q) >= 0.8
  ),
  ranked as (
    select c.kind, c.ref, c.capped,
           row_number() over (partition by c.capped order by c.prio, c.ref) as rn
      from candidates c
  )
  select p_uid, r.kind, r.ref
    from ranked r
   where r.capped = 1 or r.rn <= 7
  on conflict (user_id, kind, ref) do nothing;
end $$;

comment on function public.grant_pending_cards(uuid) is
  '把该发但未发的卡补上。只发给学生（教师/开发者直接返回）；'
  '「上线前的欠账」（§4.3.1 初始档 + week_start ≤ 2026-09-21 的历史周卡）合计封顶 7 张，'
  '超出时先裁最早的周卡、legacy 档全留；等级里程碑与上线后的周卡不封顶。幂等，靠 card_grants 唯一键兜底。';

-- ============================================================================
-- 复核
-- ============================================================================
\echo '== 1) 函数已替换（应有一条）=='
select p.proname, pg_get_function_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'grant_pending_cards';

\echo ''
\echo '== 2) 封顶常量核对（09-21 是周一、该周结束于 09-27，仍在上线日 09-30 之前）=='
select date_trunc('week', date '2026-09-21')::date as week_start,
       date_trunc('week', date '2026-09-21')::date + 6 as week_end,
       (date_trunc('week', date '2026-09-21')::date + 6) < date '2026-09-30' as ends_before_launch;

\echo ''
\echo '== 3) 角色名单（这些人现在会被 grant_pending_cards 直接跳过）=='
select coalesce(r.role, '(student)') as role, count(*)::text as people
  from public.user_roles r
 where r.role in ('teacher', 'developer')
 group by 1 order by 1;
