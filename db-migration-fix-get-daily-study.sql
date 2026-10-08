-- ============================================================================
-- 修复：get_daily_study() 被旧版覆盖（2026-10-08 事故）
--
-- 症状：学生端「连续打卡」显示 0；教师端核验页同一天却显示 7 天。
--
-- 根因：**同一个函数有两份实现，而且生产库里装的是旧的那份。**
--   · db-migration-makeup.sql（09-23，正确）：委托 `daily_study_of()`，
--     合并「基线 ∪ 事件 ∪ 补签」，字段含 correct_full / makeup。
--   · db-migration-xp-c.sql（旧）：自己内联查 `xp_events`，
--     **不读 checkin_baselines、不读 checkin_makeups**，
--     correct 还是「答对数」而不是 sum(score)。
--   `xp-c.sql` 于 09-24 又被修改并**重新整体应用**（2d1b9fa），
--   把 09-23 装好的新版**覆盖回了旧版**。此后学生端只认事件。
--
-- 后果链：
--   ① 教师端走 `get_daily_study_all()` → `daily_study_of()`（正确）；
--      学生端走 `get_daily_study()`（旧）⇒ **师生口径分裂**。
--   ② 10-08 早上回填的那 12 行 `checkin_baselines` **对学生界面零效果**
--      —— 因为学生端根本不读基线表。
--   ③ 假期那些「本地假通过」的日子，在**事件侧**本就不达标
--      ⇒ 连签在 10-03 / 10-04 就断掉 ⇒ `computeStreak` 显示 **0**。
--
-- 实测对比（10-08，A = 学生端实际走的旧版，B = 正确口径）：
--   Candice Wang    A 显示 0  |  B 显示 7
--   Eric Guo        A 显示 0  |  B 显示 7
--   慕韶菲 Snow      A 显示 0  |  B 显示 7
--   Irene Ouyang    A 显示 6  |  B 显示 7
--   Jerry Sun       A 显示 2  |  B 显示 3
--
-- ---------------------------------------------------------------------------
-- ⚠⚠ 只恢复这一个函数，**不要整体重跑 db-migration-makeup.sql**
--    —— 它里面的 `apply_makeup` 已被 09-28 的 makeup-v2 取代，
--       重跑会把补签逻辑退回 v1（那是又一次口径倒退）。
--    本文件只是把 makeup.sql 里 `get_daily_study` 那一段**逐字**搬过来。
--
-- 幂等：create or replace，可重复执行。
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

-- ---------------------------------------------------------------------------
-- 复核
-- ---------------------------------------------------------------------------
\echo '== 1) 函数体是否已改为委托 daily_study_of（两者都应为 t）=='
select (pg_get_functiondef(p.oid) like '%daily_study_of%') as uses_daily_study_of,
       (pg_get_functiondef(p.oid) like '%correct_full%')   as has_correct_full
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'get_daily_study';

\echo ''
\echo '== 2) 端到端复核：冒充一个学生走真实 RPC（全程回滚）=='
-- ⚠ `get_daily_study` 里 `auth.uid() is null` 会 raise，所以必须先设 claims 再调，
--   不能以 postgres 直接调它。也不能拿 `daily_study_of(...)` 去套 jsonb_array_length
--   —— 那个函数返回的是 **SETOF record**，不是 jsonb。
select user_id::text as uid
  from public.student_data s
 where not exists (select 1 from public.user_roles r
                    where r.user_id = s.user_id::uuid and r.role in ('teacher','developer'))
 order by (select count(*) from public.checkin_baselines b where b.user_id = s.user_id::uuid) desc
 limit 1 \gset

begin;
select set_config('request.jwt.claims',
                  json_build_object('sub', :'uid', 'role', 'authenticated')::text, false);
set local role authenticated;

-- 判据：days 应 **远大于** 修复前的 9；with_makeup 与 with_correct_full 应等于 days
with r as (select public.get_daily_study(null, null, null) as j)
select jsonb_array_length(r.j)                                                     as days,
       (select count(*) from jsonb_array_elements(r.j) x where x ? 'makeup')       as with_makeup,
       (select count(*) from jsonb_array_elements(r.j) x where x ? 'correct_full') as with_correct_full
  from r;

rollback;
