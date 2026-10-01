-- ============================================================================
-- 月度获奖记录（award_records / set_award_record）冒烟测试 —— **全程回滚**
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f app/scripts/awards-smoke-test.sql
--
-- 为什么需要：这条链路上有四处**只靠读代码看不出来**的东西 ——
--   ① 鉴权（非 staff 不能写）；② 目标校验（不能给教职工列奖）；
--   ③ `awarded` 会清掉 `delivered_at`（即「撤销已发放」）；④ 学生只能读到自己的行。
--
-- ---------------------------------------------------------------------------
-- ⚠⚠ **冒充身份时必须同时给 `role`，只给 `sub` 会得出错误结论**（2026-10-01 实测踩到）
--
-- `public.user_roles` 的唯一策略是 `auth.role() = 'authenticated'`
-- （查法：`select p.polname, pg_get_expr(p.polqual, p.polrelid) from pg_policy p
--    where p.polrelid='public.user_roles'::regclass;`）。
-- 只设 `sub` 时 `auth.role()` 是 NULL ⇒
-- **任何直接 SELECT `user_roles` 的地方都返回 0 行**，于是：
--   · `award_records` 的 `read_staff` 策略失效（它的子查询落在 user_roles 上）⇒
--     冒充教师**一条都读不到**，看起来像"策略没生效"；
--   · 用来挑目标 uid 的子查询返回 NULL ⇒ 报的错变成 `not-null constraint`
--     而不是本该报的 `target is staff`（错误信息把人带偏）。
-- ⚠ 而 `security definer` 的函数体**以属主身份跑、不受 RLS 约束** ⇒
--   同一个会话里 RPC 内部校验通过、外部 SELECT 却看不到行 —— 两边不一致极易误判。
-- ⇒ **结论：`set_config('request.jwt.claims', ...)` 里必须有 `role`。**
--   真实登录用户的 JWT 本来就有它，所以那个坑只在冒充时出现。
--
-- ⚠ 另：`$$ … $$`（DO 块）里 **psql 变量不会被替换** ⇒ 块内不能写 `:'teacher_uid'`。
--   这里改用自定义 GUC（`smoke.teacher_uid`）传递，块内用 `current_setting()` 取。
-- ⚠ `student_data.user_id` 是 **text**，而 `user_roles.user_id` / `auth.uid()` 是 **uuid**
--   ⇒ 两列直接比较会报 `operator does not exist: uuid = text`，必须显式 `::uuid`。
-- ============================================================================

begin;

\echo '== 0) 挑一个教师与一个学生（不写死 uid），并注入为 GUC =='
select r.user_id as teacher_uid
  from public.user_roles r
 where r.role = 'teacher'
 order by r.user_id
 limit 1 \gset
select s.user_id::uuid as student_uid
  from public.student_data s
 where not exists (select 1 from public.user_roles r2
                    where r2.user_id = s.user_id::uuid and r2.role in ('teacher', 'developer'))
 order by s.user_id
 limit 1 \gset
select set_config('smoke.teacher_uid', :'teacher_uid', false) as t,
       set_config('smoke.student_uid', :'student_uid', false) as s;

-- 冒充教师：**role 必须给**（见文件头说明）
select set_config('request.jwt.claims',
                  json_build_object('sub', :'teacher_uid', 'role', 'authenticated')::text,
                  false);
set role authenticated;

\echo ''
\echo '== 0b) 冒充教师后能否读到 user_roles（应为 3 行左右；0 行说明 role 没给对）=='
select count(*) as user_roles_visible from public.user_roles;

\echo ''
\echo '== 1) 列为获奖（full_attendance / awarded）=> state 应为 awarded、delivered_at 为 null =='
select public.set_award_record('2026-09', current_setting('smoke.student_uid')::uuid,
                               'full_attendance', 'awarded');

\echo ''
\echo '== 2) 勾「已发放」=> state 应为 delivered、delivered_at 非空 =='
select public.set_award_record('2026-09', current_setting('smoke.student_uid')::uuid,
                               'full_attendance', 'delivered');

\echo ''
\echo '== 3) 再勾回「awarded」=> 应清掉 delivered_at（这一条就是「撤销已发放」）=='
select public.set_award_record('2026-09', current_setting('smoke.student_uid')::uuid,
                               'full_attendance', 'awarded');

\echo ''
\echo '== 4) 月度之星也列一次（与全勤奖并存，同一个人两条）=='
select public.set_award_record('2026-09', current_setting('smoke.student_uid')::uuid,
                               'star', 'delivered');

\echo '  -- 教师视角应看得到这 2 行（read_staff 策略生效）--'
select left(user_id::text, 8) as uid8, month_key, award,
       (delivered_at is not null) as delivered
  from public.award_records order by award;

\echo ''
\echo '== 5) 幂等：同一格再点一次 delivered，不应多出一行（应仍为 2）=='
select public.set_award_record('2026-09', current_setting('smoke.student_uid')::uuid,
                               'star', 'delivered');
select count(*) as rows_after_repeat from public.award_records;

\echo ''
\echo '== 6) 负例：参数校验（每条都应报错，这里只打印错误原文）=='
do $$
declare v text;
begin
  begin
    perform public.set_award_record('2026-9', current_setting('smoke.student_uid')::uuid,
                                    'star', 'awarded');
    v := 'NO ERROR <<< FAIL';
  exception when others then v := sqlerrm;
  end;
  raise notice '  bad month_key   -> %', v;

  begin
    perform public.set_award_record('2026-09', current_setting('smoke.student_uid')::uuid,
                                    'gold_medal', 'awarded');
    v := 'NO ERROR <<< FAIL';
  exception when others then v := sqlerrm;
  end;
  raise notice '  bad award       -> %', v;

  begin
    perform public.set_award_record('2026-09', current_setting('smoke.student_uid')::uuid,
                                    'star', 'maybe');
    v := 'NO ERROR <<< FAIL';
  exception when others then v := sqlerrm;
  end;
  raise notice '  bad state       -> %', v;
end $$;

\echo ''
\echo '== 7) 负例：给教职工列奖 => 应为 target is staff（**不是** not-null constraint）=='
do $$
declare v text;
begin
  begin
    perform public.set_award_record('2026-09', current_setting('smoke.teacher_uid')::uuid,
                                    'star', 'awarded');
    v := 'NO ERROR <<< FAIL';
  exception when others then v := sqlerrm;
  end;
  raise notice '  staff as target -> %', v;
end $$;

\echo ''
\echo '== 8) 撤销获奖（none）=> 该格应被删掉（只剩 full_attendance）=='
select public.set_award_record('2026-09', current_setting('smoke.student_uid')::uuid, 'star', 'none');
select award, count(*) as n from public.award_records group by 1 order by 1;

\echo ''
\echo '== 9) 冒名学生：应能读到自己那行，但**不能**写 =='
reset role;
select set_config('request.jwt.claims',
                  json_build_object('sub', :'student_uid', 'role', 'authenticated')::text,
                  false);
set role authenticated;
\echo '  -- 学生读自己（RLS read_own 应放行）--'
select month_key, award, (delivered_at is not null) as delivered
  from public.award_records order by award;
\echo '  -- 学生调写入 RPC（应报 not allowed）--'
do $$
declare v text;
begin
  begin
    perform public.set_award_record('2026-09', current_setting('smoke.student_uid')::uuid,
                                    'star', 'awarded');
    v := 'NO ERROR <<< FAIL';
  exception when others then v := sqlerrm;
  end;
  raise notice '  student writes  -> %', v;
end $$;

reset role;

\echo ''
\echo '== 10) 回滚 =='
rollback;

\echo ''
\echo '== 11) 回滚后复核：应为 0 行 =='
select count(*) as award_records_after_rollback from public.award_records;
