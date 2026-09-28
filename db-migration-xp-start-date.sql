-- ============================================================================
-- XP 起算日（clean cut）：只统计 2026-09-30（上线日）起的事件
--
-- 用法：
--   psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f db-migration-xp-start-date.sql
--
-- 幂等（create or replace），可重复执行。
--
-- 为什么需要：XP 体系定于 **2026-09-30 上线**，且设计要求 **所有人 0 XP / LV1 开局**
--   （《XP-C档改造方案.md》§0.1 与 §三 §7 的「路径 A：零迁移」）。
--   但 `get_xp_summary` 原本是**无时间下限**的 `sum(xp_events.xp)`，
--   而事件流水从 **2026-09-23**（XP 前端首次上线）就在积累了 ——
--   截至 2026-09-28 已有 282 行 / 16 名学生。
--
--   ⇒ 若不设起算日，09-30 上线时学生**不是 0 XP**，而是「09-23 以来事件累加值」，
--     与 clean cut 的设计不符。
--
-- ⚠ 注意「XP 起算日」与「打卡口径」是**两件事**，不要一起改：
--   · XP      ：**只算起算日之后**（本脚本）—— 因为它要 clean cut；
--   · 打卡判定：**必须算全部历史**（基线 ∪ 全部事件 ∪ 补签）—— 因为 streak 是连续概念，
--     `daily_study_of()` 不能加这个过滤，否则连续天数会断、月度全勤会归零。
--
-- ⚠ `xp_events` 里 09-23~09-30 的事件**照常保留**（打卡仍需要它们），
--   本脚本只在**统计出口**过滤，不删任何数据。所以本改动**完全可逆**：
--   把 `v_xp_start` 改成更早的日期（或删掉两个 `and day_key >= v_xp_start`）重跑即可。
--
-- ⚠ 教师奖励 XP（`student_xp_bonus`）**不加起算过滤**：它是人工签发的，
--   签发本身只会发生在上线之后；且它没有 `day_key`，只有 `created_at`。
--   实测当前该表 **0 行**，不存在历史数据问题。
-- ============================================================================

create or replace function public.get_xp_summary(p_user_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- ★ 起算日：只有 day_key >= 这一天的练习事件才计入 XP。
  --   改这一行即可调整（改小 = 把更多历史算进来；不设 = 回到旧的"全量累加"）。
  --
  --   ⚠ 起算日应当**等于实际上线日（ship 日）** —— 两者不一致会让学生"上线当天做了题却没有 XP"。
  --   2026-09-28 教师定为 **2026-09-30**（并计划**半夜 ship**：学生不会在那个时段练习，
  --   于是"ship 前用旧版练的那半天"这个不一致窗口直接不存在）。
  --   若上线日再次变动，改这一行重跑即可。
  v_xp_start date := date '2026-09-30';
  v_uid      uuid := auth.uid();
  v_target   uuid;
  v_is_staff boolean;
  v_practice integer;
  v_bonus    integer;
  v_daily    jsonb;
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
     and day_key >= v_xp_start;

  -- 奖励 XP：教师签发，不计入日上限，也不受起算日限制（见文件头说明）
  select coalesce(sum(amount), 0) into v_bonus
    from public.student_xp_bonus where user_id = v_target;

  -- 逐日明细：与 v_practice 同口径过滤，否则明细求和会不等于总数
  select coalesce(jsonb_agg(jsonb_build_object('day_key', d.day_key, 'practice_xp', d.xp)
                            order by d.day_key), '[]'::jsonb)
    into v_daily
    from (select day_key, sum(xp) as xp
            from public.xp_events
           where user_id = v_target
             and day_key >= v_xp_start
           group by day_key) d;

  return jsonb_build_object(
    'practice_xp', v_practice,
    'bonus_xp',    v_bonus,
    'total_xp',    v_practice + v_bonus,
    'daily',       v_daily
  );
end $$;

comment on function public.get_xp_summary(uuid) is
  '总 XP 出口。学生只能查自己，教师/开发者可查任意。练习 XP + 奖励 XP 现算相加，永不落盘。
   ⚠ 练习 XP 只统计 day_key >= 2026-09-30（XP 起算日，clean cut，见 db-migration-xp-start-date.sql）；
      逐日明细 daily 同口径过滤。奖励 XP 不受限。';

-- 权限在 create or replace 后保持（函数 OID 不变），此处显式再授一次以防万一
grant execute on function public.get_xp_summary(uuid) to authenticated;
