-- ============================================================================
-- 月度体系（P1.5）：教师端「月度之星」榜单所需的**批量** XP 出口
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f db-migration-monthly.sql
--
-- 幂等（create or replace），可重复执行。
--
-- 前置：`db-migration-xp-c.sql` / `db-migration-xp-start-date.sql`（`get_xp_summary`）、
--       `db-migration-makeup.sql`（`get_daily_study_all`）、
--       `db-migration-definition-dispute.sql`（`student_xp_bonus`）。
--
-- ---------------------------------------------------------------------------
-- 为什么需要它
--
-- 《练级与奖励体系方案》§4.5.4 要求教师「每月 1 号之后在后台查看上月榜单
-- （按 XP 增长降序，附打卡天数与「本月新加入」标记）」。
-- 但现有 `get_xp_summary(p_user_id uuid)` **只支持单个用户** ⇒
-- 教师端要拿全班月 XP 就得**逐人调用**（20 人 = 20 次往返）。
-- 本函数一次返回全班，口径与 `get_xp_summary` 逐字一致。
--
-- ---------------------------------------------------------------------------
-- ★ 「本月 XP 增长」的口径（2026-09-29 教师定：**计入**教师签发的奖励 XP）
--
-- §4.5.2 的公式是「本月增长 = xp − monthStartXp」（xp = 练习 + 奖励），
-- 而 `useXpSummary` 的学生端实现是**对 `daily` 逐日求和** ⇒ **只含练习 XP**。
-- 两者在当前 `student_xp_bonus` 为空时相等，一旦教师开始签发就会分叉。
--
-- ⇒ 教师裁决计入奖励 XP。**不需要 `monthStartXp` / `monthKey` 两个落盘字段** ——
--   两个部分都自带时间戳，可以直接现算：
--     · 练习 XP：`xp_events.day_key`（按天）
--     · 奖励 XP：`student_xp_bonus.created_at`（按签发时刻）
--   这与本项目「总量现算、永不落盘」的既有哲学一致，也少一套需要维护的月翻转逻辑。
--
-- ⚠ 因此**学生端 `useXpSummary.monthXp` 需要同步改成计入 bonus**，
--   否则同一个「本月 XP 增长」在教师端与学生端会显示成两个数（那是最容易被当成 bug 的情形）。
--
-- ---------------------------------------------------------------------------
-- ⚠ 起算日收敛成单一来源：`public.xp_start_date()`
--
-- 原本 `date '2026-09-30'` 是写死在 `get_xp_summary` 里的字面量。本函数若再写一遍，
-- 就有了两处需要同步的常量 —— 而本项目刚为 `FULL_ATTENDANCE_DAYS` 吃过这个亏
-- （教师端与打卡页各写一份字面量，改阈值时必然漏一处）。
-- ⇒ 新增 `xp_start_date()` 作为唯一来源，并把 `get_xp_summary` 一并改成引用它
--   （**行为不变**，只是把字面量换成函数调用）。
-- ============================================================================

-- ============================================================================
-- ① XP 起算日的单一来源
-- ============================================================================
create or replace function public.xp_start_date()
returns date
language sql
immutable
as $$ select date '2026-09-30' $$;

comment on function public.xp_start_date() is
  'XP 起算日（clean cut）：只有 day_key >= 这一天的练习事件才计入 XP。'
  '唯一来源 —— get_xp_summary 与 get_xp_summary_all 都引用它，改这里即可整体调整。';

-- ============================================================================
-- ② get_xp_summary：把字面量换成 xp_start_date()（**行为与之前完全一致**）
-- ============================================================================
create or replace function public.get_xp_summary(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := auth.uid();
  v_target      uuid;
  v_is_staff    boolean;
  v_practice    integer;
  v_bonus       integer;
  v_daily       jsonb;
  v_bonus_daily jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  v_is_staff := exists (
    select 1 from public.user_roles r
     where r.user_id = v_uid and r.role in ('teacher','developer'));

  v_target := coalesce(p_user_id, v_uid);
  if v_target <> v_uid and not v_is_staff then
    raise exception 'not allowed to read other users';
  end if;

  -- 练习 XP：已应用日上限 400（写入时），此处再按起算日过滤
  select coalesce(sum(xp), 0) into v_practice
    from public.xp_events
   where user_id = v_target
     and day_key >= public.xp_start_date();

  -- 奖励 XP：教师签发，不计入日上限，也不受起算日限制（见 xp-start-date.sql 说明）
  select coalesce(sum(amount), 0) into v_bonus
    from public.student_xp_bonus where user_id = v_target;

  -- 逐日明细：与 v_practice 同口径过滤，否则明细求和会不等于总数
  select coalesce(jsonb_agg(jsonb_build_object('day_key', d.day_key, 'practice_xp', d.xp)
                            order by d.day_key), '[]'::jsonb)
    into v_daily
    from (select day_key, sum(xp) as xp
            from public.xp_events
           where user_id = v_target
             and day_key >= public.xp_start_date()
           group by day_key) d;

  -- ★ 奖励 XP 的逐日明细（2026-09-29 新增）。
  -- 为什么必须有它：学生端「今日 / 本月 XP 增长」原本只对 `daily`（练习）求和，
  --   而教师端榜单的「本月 XP 增长」是**含 bonus** 的（教师 09-29 裁定）。
  --   两边若不同口径，同一个「本月 XP 增长」会显示成两个数 —— 那是最容易被当成 bug 的情形。
  -- ⚠ 按 **Asia/Shanghai** 折算日期：`day_key` 就是按上海时区切的（见 apply_makeup 的 v_today），
  --   用服务器时区会让跨零点签发的奖励落到前一天、与打卡日错开。
  select coalesce(jsonb_agg(jsonb_build_object('day_key', b.d, 'bonus_xp', b.amt)
                            order by b.d), '[]'::jsonb)
    into v_bonus_daily
    from (select (created_at at time zone 'Asia/Shanghai')::date as d, sum(amount) as amt
            from public.student_xp_bonus
           where user_id = v_target
           group by 1) b;

  return jsonb_build_object(
    'practice_xp', v_practice,
    'bonus_xp',    v_bonus,
    'total_xp',    v_practice + v_bonus,
    'daily',       v_daily,
    'bonus_daily', v_bonus_daily
  );
end $$;

comment on function public.get_xp_summary(uuid) is
  '总 XP 出口。学生只能查自己，教师/开发者可查任意。练习 XP + 奖励 XP 现算相加，永不落盘。'
  '⚠ 练习 XP 与逐日明细（daily）都只统计 day_key >= public.xp_start_date()（clean cut）。奖励 XP 不受限，'
  '其逐日明细见 bonus_daily（按 Asia/Shanghai 归日，供「今日/本月增长」与教师端榜单同口径）。';

grant execute on function public.get_xp_summary(uuid) to authenticated;

-- ============================================================================
-- ③ 新增：全班批量 XP 出口（staff-only）
-- ============================================================================
-- 返回每个学生：
--   user_id        学生
--   practice_all   累计练习 XP（起算日之后）
--   bonus_all      累计奖励 XP
--   total_all      = practice_all + bonus_all（与 get_xp_summary.total_xp 同口径）
--   practice_range 区间内的练习 XP（不传 from/to 即全量）
--   bonus_range    区间内的奖励 XP
--   range_xp       = practice_range + bonus_range ← **「本月 XP 增长」**
--   joined_month   账号创建**年月**（'YYYY-MM'，按 Asia/Shanghai 折算）—— 判断「本月新加入」（§4.5.3）
--
-- ⚠ 为什么不直接返回 `joined_at` 让前端自己比较月份：**时区折算必须只有一份**。
--   若前端拿 UTC 时间戳去 `slice(0,7)`，在「月末最后几小时建号」的情况下会与上海口径的月份
--   差一个月（如 08-31 20:00 UTC = 09-01 04:00 上海）⇒ 那个人会被错误地判成"9 月新加入"而失去参评资格。
--   `day_key` 本来就是按上海时区切的（见 apply_makeup 的 v_today），这里保持一致。
--
-- ⚠ 名单口径与 `get_daily_study_all` **刻意一致**（`student_data` 去重、排除 teacher/developer）：
--   教师端月度核验要在两张表之间对得上人，名单若各算各的，就会出现「榜单里有、核验表里没有」。
--   这也意味着**从未上传过 `student_data` 的账号不会出现**（与现有教师端口径相同）。
--
-- ⚠ `joined_at` 取 **账号创建时刻**，而不是「首次练习」：§4.5.3 判的是「本月加入的同学」，
--   账号创建是最接近且权威的信号。代价是「早就建号、近期才启用」的人**算作老同学**（可参评）——
--   这与「次月参评」的初衷一致：那条规则要排除的是**月中才开始的人**，而不是启用得晚的人。
create or replace function public.get_xp_summary_all(
  p_from date default null,
  p_to   date default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_is_staff boolean;
  v_out      jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  v_is_staff := exists (
    select 1 from public.user_roles r
     where r.user_id = v_uid and r.role in ('teacher', 'developer'));
  if not v_is_staff then
    raise exception 'not allowed to read all users';
  end if;

  return (
    with roster as (
      -- 与 get_daily_study_all 同一判据：以 student_data 为准，排除教职工
      select distinct s.user_id::uuid as user_id
        from public.student_data s
       where not exists (
         select 1 from public.user_roles r
          where r.user_id = s.user_id::uuid
            and r.role in ('teacher', 'developer'))
    ),
    pe as (
      -- 练习 XP：全部与区间各一次聚出来（避免为每行再扫一遍 xp_events）
      select e.user_id,
             sum(e.xp) as practice_all,
             sum(e.xp) filter (
               where (p_from is null or e.day_key >= p_from)
                 and (p_to   is null or e.day_key <= p_to)
             ) as practice_range
        from public.xp_events e
       where e.day_key >= public.xp_start_date()
       group by e.user_id
    ),
    bo as (
      -- 奖励 XP：按签发时刻归属到某天。⚠ 必须按 Asia/Shanghai 折算 ——
      -- `day_key` 就是按上海时区切的（见 apply_makeup 的 v_today），
      -- 若这里用服务器时区，跨零点签发的奖励会落到前一天、与打卡日错开。
      select b.user_id,
             sum(b.amount) as bonus_all,
             sum(b.amount) filter (
               where (p_from is null or (b.created_at at time zone 'Asia/Shanghai')::date >= p_from)
                 and (p_to   is null or (b.created_at at time zone 'Asia/Shanghai')::date <= p_to)
             ) as bonus_range
        from public.student_xp_bonus b
       group by b.user_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'user_id',        c.user_id,
             'practice_all',   coalesce(pe.practice_all, 0),
             'bonus_all',      coalesce(bo.bonus_all, 0),
             'total_all',      coalesce(pe.practice_all, 0) + coalesce(bo.bonus_all, 0),
             'practice_range', coalesce(pe.practice_range, 0),
             'bonus_range',    coalesce(bo.bonus_range, 0),
             'range_xp',       coalesce(pe.practice_range, 0) + coalesce(bo.bonus_range, 0),
             'joined_month',   to_char(u.created_at at time zone 'Asia/Shanghai', 'YYYY-MM')
           ) order by c.user_id), '[]'::jsonb)
      from roster c
      left join auth.users u on u.id = c.user_id
      left join pe on pe.user_id = c.user_id
      left join bo on bo.user_id = c.user_id
  );
end $$;

grant execute on function public.get_xp_summary_all(date, date) to authenticated;

comment on function public.get_xp_summary_all(date, date) is
  '教师端：一次取全班 XP（staff-only）。range_xp = 区间内练习 XP + 奖励 XP（即「本月 XP 增长」，含 bonus）。'
  '⚠ 名单口径与 get_daily_study_all 一致（student_data 去重、排除教职工）。joined_at = 账号创建时刻。';

-- ============================================================================
-- ④ 复核
--
-- ⚠ **这里刻意不调用 `get_xp_summary_all` / `get_daily_study_all`** ——
--   它们是 staff-only，直接调用会因 `auth.uid()` 为空而 `raise exception`，
--   在 `ON_ERROR_STOP=1` 下会让整个迁移看起来"失败"（虽然前面的 DDL 其实已生效）。
--   需要登录态的验证另跑一个脚本（临时冒充 teacher 调一次），见下方说明。
-- ============================================================================
\echo '== 起算日单一来源（应 2026-09-30）=='
select public.xp_start_date() as xp_start;

\echo ''
\echo '== 三个函数都存在且签名正确 =='
select p.proname, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as ret
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('xp_start_date', 'get_xp_summary', 'get_xp_summary_all')
 order by p.proname;

\echo ''
\echo '== 名单口径自查：student_data 里的学生数（排除教职工）—— 两个 all 函数共用这一份判据 =='
select count(*) as roster_n
  from (
    select distinct s.user_id::uuid as user_id
      from public.student_data s
     where not exists (
       select 1 from public.user_roles r
        where r.user_id = s.user_id::uuid and r.role in ('teacher', 'developer'))
  ) x;

\echo ''
\echo '== 起算日之前/之后的事件数（现在是 0，因为 09-30 还没到）'
\echo '   ⇒ 上线前每个人的 XP 都应为 0，上线后才开始增长 =='
select count(*) filter (where day_key <  public.xp_start_date()) as before_start,
       count(*) filter (where day_key >= public.xp_start_date()) as on_or_after_start
  from public.xp_events;

\echo ''
\echo '== 教师奖励 XP 表现状（range_xp 里 bonus 那一半的来源）=='
select count(*) as bonus_rows, coalesce(sum(amount), 0) as bonus_sum from public.student_xp_bonus;
