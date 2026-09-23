-- ============================================================================
-- 补签服务端化 + 每日打卡三源合并（第④步的 ①②③）
-- 2026-09-23
--
-- 设计见《XP-C档改造方案.md》§六之七 / §六之八。**纯新增 + 替换一个已有函数**，
-- 幂等，可重复执行。
--
-- 为什么需要这一批：打卡判定要切到服务端，但服务端此前只有
--   `xp_events`（练习事件）与 `checkin_baselines`（历史基线），**新的补签没有落点**。
--   而补签直接改变「达标天数」，全勤奖又是实物出口 ⇒ 不服务端化就仍有一条
--   客户端可篡改的路径（本地 `makeup` 只是一个 { dayKey: true } 映射，插一条就多一天）。
--
-- 组成：
--   ① checkin_makeups            补签记录（一周一次，替代本地 earnedMakeupWeeks）
--   ② daily_study_of()           **内部**三源合并（基线 ∪ 事件 ∪ 补签），口径唯一
--   ③ apply_makeup()             补签入口（服务端校验四项）
--   ④ get_daily_study()          改造：改为基于 ②（返回加 makeup / correct_full）
--   ⑤ get_daily_study_all()      教师端全班（staff-only）
--
-- ⚠ 两条容易算错的口径，本脚本已按裁决实现（详见 §六之八）：
--   · **correct = sum(score)**，不是「答对数」（本地 DayStudy.correct 也是 score 累加）；
--     另有 correct_full 才是布尔全对计数，且**基线部分只能为 NULL**（没存过）。
--   · **基线的 seconds 是「秒」，事件是「毫秒」** ⇒ 合并时必须 ×1000。
-- ============================================================================


-- ============================================================================
-- ① checkin_makeups：补签记录
--
-- unique(user_id, week_start) 就是「一周只能补一次」这条规则本身 ——
-- 它替代了本地的 earnedMakeupWeeks（后者是"哪些周已领过"的数组）。
-- ============================================================================
create table if not exists public.checkin_makeups (
  user_id    uuid        not null,
  day_key    date        not null,      -- 被补签的那一天
  week_start date        not null,      -- 该天所在周的周一（= 动作周；机制只允许补本周）
  created_at timestamptz not null default now(),
  primary key (user_id, day_key),
  unique (user_id, week_start)
);

create index if not exists checkin_makeups_user_day_idx
  on public.checkin_makeups (user_id, day_key);

-- RLS 与 xp_events / checkin_baselines 同口径：学生只读自己的、教师/开发者可读全校。
-- **没有任何写策略** —— 写只能经 apply_makeup()（它内部做归属与规则校验）。
alter table public.checkin_makeups enable row level security;

drop policy if exists checkin_makeups_read_own on public.checkin_makeups;
create policy checkin_makeups_read_own on public.checkin_makeups
  for select using (auth.uid() = user_id);

drop policy if exists checkin_makeups_read_staff on public.checkin_makeups;
create policy checkin_makeups_read_staff on public.checkin_makeups
  for select using (exists (
    select 1 from public.user_roles r
     where r.user_id = auth.uid() and r.role in ('teacher', 'developer')));

revoke truncate, references, trigger on public.checkin_makeups from authenticated;
revoke all on public.checkin_makeups from anon;

comment on table public.checkin_makeups is
  '补签记录。unique(user_id, week_start) 即「一周只能补一次」；替代本地 earnedMakeupWeeks。写只能经 apply_makeup()。';


-- ============================================================================
-- ② daily_study_of()：**内部**三源合并（口径唯一）
--
-- 为什么要有这个内部函数：学生端与教师端必须**共用同一份合并逻辑**，
--   否则「基线 + 事件 + 补签」这套口径会被复制成两份实现、迟早分叉。
--   §六之七 裁决 1 因此放弃了视图方案（视图会复制口径）。
--
-- ⚠ 本函数**不做归属校验**（它只是个聚合器），所以**权限必须收死**：
--   见文件末尾的 revoke —— 只有 security definer 的包装函数能调它。
-- ============================================================================
create or replace function public.daily_study_of(
  p_user_id uuid,
  p_from    date default null,
  p_to      date default null
) returns table (
  day_key      date,
  questions    integer,
  ms           integer,
  correct      numeric,
  correct_full integer,   -- ⚠ 基线部分为 NULL（当时没存过布尔计数，不能用 floor 近似）
  makeup       boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  with ev as (
    select e.day_key,
           -- ⚠ count(*) / sum(integer) 在 PG 里返回 bigint，而本函数的输出列声明为 integer
           --   ⇒ **必须显式转型**，否则运行时报 "Returned type bigint does not match
           --   expected type integer"（这不是编译期错误，只在真正调用时才暴露）。
           (count(*) filter (where e.kind = 'answer'))::integer            as questions,
           (coalesce(sum(e.elapsed_ms) filter (where e.kind = 'answer'), 0))::integer as ms,
           -- ⚠ correct 取 sum(score)：与本地 DayStudy.correct 同口径。
           --   若用 count(*) filter (where correct)（布尔版），一周 10 题全 partial 会
           --   从本地的 50% 变成 0%，补签门槛被无声抬高。
           coalesce(sum(e.score) filter (where e.kind = 'answer'), 0)::numeric as correct,
           (count(*) filter (where e.kind = 'answer' and e.correct))::integer  as correct_full
      from public.xp_events e
     where e.user_id = p_user_id
       and (p_from is null or e.day_key >= p_from)
       and (p_to   is null or e.day_key <= p_to)
     group by e.day_key
  ),
  bl as (
    select b.day_key,
           b.questions,
           -- ⚠ 基线存的是「秒」，事件侧是「毫秒」⇒ 必须 ×1000。
           --   漏了会让历史时长趋于 0，把已达标的历史日误判为未达标 ——
           --   而历史日正是这张表唯一的用途。
           (b.seconds::bigint * 1000) as ms,
           b.correct,
           null::integer              as correct_full   -- 基线没有布尔全对计数，如实记 NULL
      from public.checkin_baselines b
     where b.user_id = p_user_id
       and (p_from is null or b.day_key >= p_from)
       and (p_to   is null or b.day_key <= p_to)
  ),
  mk as (
    select m.day_key
      from public.checkin_makeups m
     where m.user_id = p_user_id
       and (p_from is null or m.day_key >= p_from)
       and (p_to   is null or m.day_key <= p_to)
  ),
  all_days as (
    select ev.day_key from ev
    union
    select bl.day_key from bl
    union
    select mk.day_key from mk
  )
  select d.day_key,
         (coalesce(e.questions, 0) + coalesce(b.questions, 0))::integer        as questions,
         (coalesce(e.ms, 0)        + coalesce(b.ms, 0))::integer               as ms,
         (coalesce(e.correct, 0)   + coalesce(b.correct, 0))::numeric          as correct,
         case
           when e.correct_full is null and b.correct_full is null then null
           else coalesce(e.correct_full, 0) + coalesce(b.correct_full, 0)
         end                                                                   as correct_full,
         (m.day_key is not null)                                               as makeup
    from all_days d
    left join ev e on e.day_key = d.day_key
    left join bl b on b.day_key = d.day_key
    left join mk m on m.day_key = d.day_key
   order by d.day_key;
end $$;

comment on function public.daily_study_of(uuid, date, date) is
  '内部：每日打卡三源合并（基线 ∪ 事件 ∪ 补签），学生端与教师端共用。⚠ correct = sum(score)（与本地同口径）；correct_full 仅事件侧可得，基线部分为 NULL；基线 seconds 已 ×1000 转毫秒。


  ⚠ 缺时长的题按 0 毫秒计（elapsed_ms 允许为 NULL，见 submit_xp_events 防线 #4）。';


-- ============================================================================
-- ③ apply_makeup()：补签入口（服务端校验）
--
-- 把本地 applyMakeup / canEarnMakeup / missedDaysInWeek 的三道判断搬到服务端，
-- **客户端不再自行判定**。
--
-- 校验顺序（先便宜后昂贵）：
--   1) 必须登录；
--   2) 目标日必须「早于今天」且「在本周内」（机制：只补本周漏签日）；
--   3) 该天尚未达标（练习够线 或 已补签）—— 达标了就不该浪费补签机会；
--   4) 本周练习 ≥100 题且 correct/questions ≥80%（**与本地 canEarnMakeup 同口径**）；
--   5) 本周尚未补过（unique(user_id, week_start) 兜底）。
-- ============================================================================
create or replace function public.apply_makeup(p_day_key date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_today      date;
  v_week_start date;
  v_questions  integer;
  v_ms         integer;
  v_correct    numeric;
  v_ratio      numeric;
  v_chk        record;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_day_key is null then
    raise exception 'p_day_key is required';
  end if;

  -- 「今天」与「本周」都按 Asia/Shanghai 取，与 day_key 同源
  v_today      := (now() at time zone 'Asia/Shanghai')::date;
  v_week_start := date_trunc('week', v_today)::date;   -- 周一；已实测与前端 weekStartKey 一致

  -- 2) 只允许补「本周内、且早于今天」的日子
  if p_day_key >= v_today then
    return jsonb_build_object('ok', false, 'reason', 'not_past_day');
  end if;
  if date_trunc('week', p_day_key)::date <> v_week_start then
    return jsonb_build_object('ok', false, 'reason', 'not_this_week');
  end if;

  -- 3) 该天尚未达标（达标 = 题数 ≥20 且时长 ≥600 秒；补签也算已达标）
  select * into v_chk from public.daily_study_of(v_uid, p_day_key, p_day_key) limit 1;
  if found then
    if v_chk.makeup then
      return jsonb_build_object('ok', false, 'reason', 'already_made_up');
    end if;
    if v_chk.questions >= 20 and v_chk.ms >= 600 * 1000 then
      return jsonb_build_object('ok', false, 'reason', 'already_checked');
    end if;
  end if;

  -- 4) 本周练习量：题数 ≥100 且 correct/questions ≥80%（口径与本地 canEarnMakeup 一致）
  select coalesce(sum(d.questions), 0),
         coalesce(sum(d.ms), 0),
         coalesce(sum(d.correct), 0)
    into v_questions, v_ms, v_correct
    from public.daily_study_of(v_uid, v_week_start, v_week_start + 6) d;

  if v_questions < 100 then
    return jsonb_build_object('ok', false, 'reason', 'week_questions_low',
                              'questions', v_questions, 'need', 100);
  end if;
  -- ⚠ 分子用 correct = sum(score)，与本地 weeklyStats 的 correct 同口径；
  --   若这里改用布尔计数，会出现「本地判得过、服务端判不过」。
  v_ratio := case when v_questions > 0 then v_correct / v_questions else 0 end;
  if v_ratio < 0.8 then
    return jsonb_build_object('ok', false, 'reason', 'week_accuracy_low',
                              'ratio', round(v_ratio, 4), 'need', 0.8);
  end if;

  -- 5) 落库；unique(user_id, week_start) 是最后一道兜底（并发下也只会成功一条）
  begin
    insert into public.checkin_makeups (user_id, day_key, week_start)
    values (v_uid, p_day_key, v_week_start);
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'week_already_used');
  end;

  return jsonb_build_object('ok', true, 'day_key', p_day_key, 'week_start', v_week_start);
end $$;

grant execute on function public.apply_makeup(date) to authenticated;

comment on function public.apply_makeup(date) is
  '补签入口（服务端校验）。一周只能补一次；只允许补本周内、早于今天、且尚未达标的日子；要求本周 ≥100 题且正确率 ≥80%（correct 取 sum(score)，与本地同口径）。';


-- ============================================================================
-- ④ get_daily_study()：改造为基于 ②
--
-- 与旧版的差别：① correct 从「布尔计数」改为 **sum(score)**（与本地同口径）；
--               ② 新增 correct_full 与 makeup 两个字段；
--               ③ 合并基线（旧版只看事件）。
-- 返回仍为 jsonb 数组，字段只增不改 ⇒ 调用方不受影响。
-- ============================================================================
create or replace function public.get_daily_study(
  p_user_id uuid default null,
  p_from    date default null,
  p_to      date default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_target   uuid;
  v_is_staff boolean;
  v_out      jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  v_is_staff := exists (
    select 1 from public.user_roles r
     where r.user_id = v_uid and r.role in ('teacher', 'developer'));

  v_target := coalesce(p_user_id, v_uid);
  if v_target <> v_uid and not v_is_staff then
    raise exception 'not allowed to read other users';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'day_key',      d.day_key,
           'questions',    d.questions,
           'ms',           d.ms,
           'correct',      d.correct,
           'correct_full', d.correct_full,
           'makeup',       d.makeup
         ) order by d.day_key), '[]'::jsonb)
    into v_out
    from public.daily_study_of(v_target, p_from, p_to) d;

  return v_out;
end $$;

grant execute on function public.get_daily_study(uuid, date, date) to authenticated;

comment on function public.get_daily_study(uuid, date, date) is
  '每日打卡聚合（打卡判定用）。单用户；合并基线 ∪ 事件 ∪ 补签。⚠ correct = sum(score)，correct_full 仅事件侧可得。';


-- ============================================================================
-- ⑤ get_daily_study_all()：教师端一次拿全班
--
-- 为什么是 RPC 而不是视图（§六之七 裁决 1）：视图会把「基线 + 事件 + 补签」的合并口径
-- 复制成第二份实现，与学生端走的 RPC 分叉。这里复用同一个 ②，口径唯一。
-- staff-only；且**不改 get_daily_study 的语义**（那里 null ⇒ 读自己，学生端在用）。
-- ============================================================================
create or replace function public.get_daily_study_all(
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

  -- 取人：以 `student_data` 为准（教师端的数据源本就是它），并排除教职工与测试号
  -- （`role in ('teacher','developer')`，与导入基线同一判据，见 §六之八）。
  --
  -- ⚠ 用 left join lateral 而不是「先展开天再 group by」：后者会把
  --   **没有任何打卡数据的学生整个漏掉**，而教师做月度核验时必须看到全量名单
  --   （未达标的学生恰恰是核验的重点）。无数据者 `days = []`。
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', c.user_id,
           'days',    coalesce(t.days, '[]'::jsonb)
         ) order by c.user_id), '[]'::jsonb)
    into v_out
    from (
      select distinct s.user_id::uuid as user_id
        from public.student_data s
       where not exists (
         select 1 from public.user_roles r
          where r.user_id = s.user_id::uuid
            and r.role in ('teacher', 'developer'))
    ) c
    left join lateral (
      select jsonb_agg(jsonb_build_object(
               'day_key',      d.day_key,
               'questions',    d.questions,
               'ms',           d.ms,
               'correct',      d.correct,
               'correct_full', d.correct_full,
               'makeup',       d.makeup
             ) order by d.day_key) as days
        from public.daily_study_of(c.user_id, p_from, p_to) d
    ) t on true;

  return v_out;
end $$;

grant execute on function public.get_daily_study_all(date, date) to authenticated;

comment on function public.get_daily_study_all(date, date) is
  '教师端：一次取全班每日打卡（staff-only）。复用 daily_study_of，口径与学生端一致。';


-- ============================================================================
-- 权限收口：daily_study_of 是**内部**聚合器，不做归属校验 ⇒ 客户端角色一律不可调。
-- （Postgres 新函数默认对 PUBLIC 可执行，必须显式收回。）
-- ============================================================================
revoke all on function public.daily_study_of(uuid, date, date) from public;
revoke all on function public.daily_study_of(uuid, date, date) from anon;
revoke all on function public.daily_study_of(uuid, date, date) from authenticated;
