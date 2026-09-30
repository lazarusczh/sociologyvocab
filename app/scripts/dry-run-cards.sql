-- ============================================================================
-- 初始发放 dry run（全程回滚，不留痕）
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f app/scripts/dry-run-cards.sql
--
-- 为什么需要：`grant_pending_cards()` 的发放结果**取决于当时的数据**
-- （累计达标天数 / 最长连续 / 历史周卡），而数据每天都在变。
-- ⇒ **每次跑完 `catch-up-checkin.sql` 之后都要复跑本脚本**，否则看到的是旧分布。
--   历史上这个 dry run 一直是临时敲的 SQL、没有留档，每次都要重发明一遍。
--
-- 设计要点：先把 `card_grants` 的现状快照进临时表 `before`，跑完只显示**本次新增的行**
-- ⇒ 即使表里已经有真实发放或测试发放（`devtest:`），也不会把它们误当成这次算出来的。
--
-- ⚠ 全程 `begin … rollback`：`grant_pending_cards()` 只往 `card_grants` 写入，
--   所以回滚是干净的。最后一段会复核行数确实没变。
-- ============================================================================

\echo '== 0) card_grants 现状（按 ref 前缀分类；devtest = 开发者手动发卡，非学生）=='
select case when ref like 'devtest:%' then 'devtest' else 'real' end as src,
       kind, count(*) as n
  from public.card_grants group by 1, 2 order by 1, 2;

begin;

create temp table before as
  select user_id, kind, ref from public.card_grants;

\echo ''
\echo '== 1) 触发发放（对全部账号；函数自身会跳过 teacher/developer）=='
select public.grant_pending_cards(u.id) from auth.users u;

\echo ''
\echo '== 2) 本次新增：按 kind =='
select g.kind, count(*) as n
  from public.card_grants g
 where not exists (select 1 from before b
                    where b.user_id = g.user_id and b.kind = g.kind and b.ref = g.ref)
 group by 1 order by 1;

\echo ''
\echo '== 3) 本次新增：逐人逐条（uid 取前 8 位）=='
select left(g.user_id::text, 8) as uid8, g.kind, g.ref
  from public.card_grants g
 where not exists (select 1 from before b
                    where b.user_id = g.user_id and b.kind = g.kind and b.ref = g.ref)
 order by 1, 3;

\echo ''
\echo '== 4) 本次 run 之后：每人非 devtest 卡数（封顶后应为 <= 7）=='
select left(user_id::text, 8) as uid8,
       count(*) filter (where kind = 'makeup') as makeup,
       count(*) filter (where kind = 'bonus')  as bonus,
       count(*) as total
  from public.card_grants
 where ref not like 'devtest:%'
 group by 1 order by total desc, 1;

\echo ''
\echo '== 5) 汇总：得卡人数 / 学生行数 / 教师开发者拿卡数（后者应为 0）=='
select (select count(distinct user_id) from public.card_grants where ref not like 'devtest:%') as students_with_cards,
       (select count(*) from public.student_data) as student_rows,
       (select count(*) from public.card_grants g
         where exists (select 1 from public.user_roles r
                        where r.user_id = g.user_id and r.role in ('teacher', 'developer'))) as staff_rows;

rollback;

\echo ''
\echo '== 6) 回滚后复核：行数应与第 0 节一致 =='
select count(*) as card_grants_after_rollback from public.card_grants;
