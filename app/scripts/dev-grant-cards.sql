-- ============================================================================
-- 开发者测试用：**手动发卡**（补签卡 / 加分卡）
--
-- 用途：`grant_pending_cards()` 现在会跳过 teacher / developer（§4.3.1 要求"只发给学生"），
--   所以**开发者账号自动发不出卡**，没法测试补签与加分卡。本脚本**绕开发放规则**手动插流水。
--
-- ⚠ 这是刻意的「两件事分开」，不是补丁：
--   · **自动发放**只给学生 —— 那是 §4.3.1 的规则：教师账号通常也有打卡历史，
--     不该被系统当成"老同学"白拿卡（实测教师/开发者确实一张未得）。
--   · **手动发卡**不设角色限制 —— 它本来就是给测试与人工补偿用的带外通道。
--   余额的三个消费方（`get_card_balance()` / `apply_makeup()` / `use_bonus_card()`）
--   **只数流水、不看角色** ⇒ 手动插进去的卡**立刻可用**，无需改任何函数。
--
-- ⚠ 故意**不做成 RPC**：那等于在生产库里开一个"客户端可调用的发卡入口"，
--   而卡余额会影响**全勤奖（实物出口）**。psql 是带外通道，客户端碰不到它。
--
-- 用法（`who` 可填 uuid / 邮箱 / `@devs`）：
--   psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -v who=@devs -v makeup=3 -v bonus=2 \
--        -f app/scripts/dev-grant-cards.sql
--
-- 撤销（**只删测试行**，不碰真实发放）：
--   psql ... -c "delete from public.card_grants where ref like 'devtest:%';"
--
-- ⚠ `makeup` / `bonus` 必须 **≥ 1**：本脚本用 `\if :{?var}` 判断"有没有传"，
--   而 `\if 0` 会被当成"没传"从而回落到默认值 —— 传 0 张本来也没有意义。
--
-- ⚠ 测试行一律带 `devtest:` 前缀，所以撤销是一条 `like` 就够，不会误删发放。
-- ⚠ 每次运行**递增**（ref 带序号），所以可以反复跑、越跑越多；要清零先跑上面的撤销。
-- ============================================================================
\set ON_ERROR_STOP on

-- 默认张数（不传就 3 / 2）
\if :{?makeup}
\else
  \set makeup 3
\endif
\if :{?bonus}
\else
  \set bonus 2
\endif

\echo '== 目标账号（who = 你传入的值；@devs = 全部 developer）=='
select left(u.id::text, 8) as uid8, u.email, coalesce(r.role, '(student)') as role
  from auth.users u
  left join public.user_roles r on r.user_id = u.id
 where (:'who' = '@devs'
        and exists (select 1 from public.user_roles r2
                     where r2.user_id = u.id and r2.role = 'developer'))
    or u.id::text = :'who'
    or lower(u.email) = lower(:'who')
 order by u.email;

begin;

-- 插入：ref 从「已有的 devtest 条数」续号，所以重复运行不会撞唯一键、而是继续加
with targets as (
  select u.id as uid
    from auth.users u
   where (:'who' = '@devs'
          and exists (select 1 from public.user_roles r
                       where r.user_id = u.id and r.role = 'developer'))
      or u.id::text = :'who'
      or lower(u.email) = lower(:'who')
),
base as (
  select t.uid,
         (select count(*) from public.card_grants g
           where g.user_id = t.uid and g.ref like 'devtest:makeup:%') as m0,
         (select count(*) from public.card_grants g
           where g.user_id = t.uid and g.ref like 'devtest:bonus:%') as b0
    from targets t
)
insert into public.card_grants (user_id, kind, ref)
select b.uid, 'makeup', 'devtest:makeup:' || (b.m0 + s.i)::text
  from base b, generate_series(1, :makeup) as s(i)
union all
select b.uid, 'bonus', 'devtest:bonus:' || (b.b0 + s.i)::text
  from base b, generate_series(1, :bonus) as s(i);

commit;

\echo ''
\echo '== 这些账号的卡余额（算法与 get_card_balance() 完全一致：发放 − 使用）=='
with devs as (select distinct user_id from public.card_grants where ref like 'devtest:%')
select left(g.user_id::text, 8) as uid8,
       (count(*) filter (where g.kind = 'makeup')
        - (select count(*) from public.checkin_makeups m where m.user_id = g.user_id))::text as makeup_balance,
       (count(*) filter (where g.kind = 'bonus')
        - (select count(*) from public.card_uses x
            where x.user_id = g.user_id and x.kind = 'bonus'))::text as bonus_balance
  from public.card_grants g
  join devs d on d.user_id = g.user_id
 group by g.user_id
 order by 1;

\echo ''
\echo '== 撤销命令（复制即用）=='
\echo '   delete from public.card_grants where ref like $$devtest:%$$;'
