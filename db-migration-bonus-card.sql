-- ============================================================================
-- 加分卡的使用（《练级与奖励体系方案》§4.2.1）
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f db-migration-bonus-card.sql
--
-- 前置：`db-migration-cards.sql`（发放流水 `card_grants` + 使用流水 `card_uses` + 余额）。
--
-- 幂等，可重复执行。
--
-- ---------------------------------------------------------------------------
-- 这一份补的是「卡系统的另一半」
--
-- `db-migration-cards.sql` 建好了 `card_uses` 表，但**全仓没有任何地方往它写入** ——
-- 也就是说：补签卡已经能用了（它的"使用"由 `checkin_makeups` 承担，不需要 `card_uses`），
-- 而**加分卡只有发放、没有消耗**，余额永远只增不减。
-- 本函数就是那个缺失的写入点。
--
-- ---------------------------------------------------------------------------
-- 为什么必须是服务端 RPC，而不是像订正加分那样在前端算完再 UPDATE
--
-- 订正加分（`CorrectionPractice.tsx` → `saveCorrection`）是**前端直接 UPDATE**
-- `quiz_submissions.grading` 的 —— 那条路成立是因为它只改自己那一行、且没有竞争。
--
-- 加分卡不同：它要**同时**做两件事 ——
--   ① 往 `card_uses` 插一条使用流水（幂等键保证"每份限用 1 张"）；
--   ② 回写 `grading.card_bonus` 与 `final_score`。
-- 分成两个前端请求就会出现"扣了卡但没加上分"或反之的中间态。而且余额必须由服务端裁定
-- （`db-migration-cards.sql` 的设计裁决：余额放服务端，否则全勤奖仍有本地可改的路径）。
-- ⇒ 一个 `security definer` 函数，两件事在一个事务里。
--
-- ---------------------------------------------------------------------------
-- 「满分」为什么要在 SQL 里现算
--
-- 加分额 = **真实满分的 10%**（§4.2.1）。而满分**不是存储字段** ——
-- 前端的 `totalPoints()`（`lib/quiz.ts`）是从作业的题目快照现算的：
-- **matching 题按"对数"计分，其余每题 1 分**。下方 `v_M` 的算法就是它的 SQL 转写。
-- ⚠ 两处必须一致：翻错了不是报错，而是**静默多发或少发**（学生看到 +0 或 +3 而不是 +2）。
--
-- ⚠ 已知局限（与订正加分同源，不是本函数引入的）：`M` 取自 `quizzes.questions`
--   **当前**的快照。若教师在交卷后改了题目，M 会跟着变。这是既有行为。
-- ============================================================================

create or replace function public.use_bonus_card(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_sub     record;
  v_M       integer;
  v_card    integer;
  v_bal     integer;
  v_penalty integer;
  v_bonus   integer;
  v_final   integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_submission_id is null then
    raise exception 'p_submission_id is required';
  end if;

  select s.id, s.user_id, s.quiz_id, s.score, s.status, s.grading
    into v_sub
    from public.quiz_submissions s
   where s.id = p_submission_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- 只能给自己的答卷加分（`security definer` 绕过了 RLS，所以这条必须显式写）
  if v_sub.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  if v_sub.status <> 'submitted' then
    return jsonb_build_object('ok', false, 'reason', 'not_submitted');
  end if;

  -- 每份限用 1 张。**判据是「grading 里有没有 card_bonus 这个键」而不是它的值** ——
  -- 值可能是 0（满分很小的作业 round(M×10%) 会取整到 0），用值判断会漏掉那种情况。
  if v_sub.grading is not null and jsonb_exists(v_sub.grading, 'card_bonus') then
    return jsonb_build_object('ok', false, 'reason', 'already_used');
  end if;

  -- 真实满分：等价于前端 `totalPoints()` —— matching 按对数、其余每题 1 分
  select coalesce(sum(
           case
             when (e.q ->> 'type') = 'matching'
               and jsonb_typeof(e.q -> 'pairs') = 'array'
             then jsonb_array_length(e.q -> 'pairs')
             else 1
           end), 0)::integer
    into v_M
    from public.quizzes z
    cross join lateral jsonb_array_elements(coalesce(z.questions, '[]'::jsonb)) as e(q)
   where z.id = v_sub.quiz_id;

  if coalesce(v_M, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_points');
  end if;

  -- 有卡才能用（与 apply_makeup 同一套「先补发、再数余额」的做法）
  perform public.grant_pending_cards(v_uid);
  select count(*) into v_bal
    from public.card_grants g
   where g.user_id = v_uid and g.kind = 'bonus';
  v_bal := v_bal - (select count(*) from public.card_uses u
                     where u.user_id = v_uid and u.kind = 'bonus');
  if v_bal <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_cards', 'balance', 0);
  end if;

  -- 扣卡。⚠ `on conflict do nothing` + 检查 `found` 是「每份限用 1 张」的**第二道**保险：
  --   上面那个键检查挡的是同一个用户重复点；这里挡的是并发两个请求同时通过检查。
  insert into public.card_uses (user_id, kind, ref)
  values (v_uid, 'bonus', v_sub.quiz_id::text)
  on conflict (user_id, kind, ref) do nothing;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'already_used');
  end if;

  -- 加分额 = 真实满分的 10%（§4.2.1：与订正加分同一口径，学生不必理解两套算法）
  v_card := round(v_M::numeric * 0.1)::integer;

  -- 与既有结算同形：final = clamp(score − penalty + bonus + card_bonus, 0, M)
  -- ⇒ 加分卡**叠加在订正加分之上**（两者独立并存），但**仍然满分封顶**。
  v_penalty := coalesce((v_sub.grading ->> 'penalty')::integer, 0);
  v_bonus   := coalesce((v_sub.grading ->> 'bonus')::integer, 0);
  v_final   := greatest(0, least(v_sub.score - v_penalty + v_bonus + v_card, v_M));

  update public.quiz_submissions
     set grading = coalesce(v_sub.grading, '{}'::jsonb)
                   || jsonb_build_object('card_bonus', v_card, 'final_score', v_final)
   where id = p_submission_id;

  return jsonb_build_object(
    'ok', true,
    'card_bonus', v_card,
    'final_score', v_final,
    'max_points', v_M,
    'balance', greatest(0, v_bal - 1)
  );
end $$;

grant execute on function public.use_bonus_card(uuid) to authenticated;

comment on function public.use_bonus_card(uuid) is
  '用一张加分卡给某份答卷加分（满分 10%，与订正加分可叠加、满分封顶）。每份限用 1 张，'
  '由 card_uses 的 unique(user_id,kind,ref) 保证；余额服务端现算，无卡不可用。';

-- ============================================================================
-- 复核
-- ============================================================================
\echo '== use_bonus_card 是否存在且仅 authenticated 可执行 =='
select p.proname, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as ret
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'use_bonus_card';

\echo ''
\echo '== card_uses 现状（应仍为空；本函数只有学生点按钮才会写入）=='
select 'card_uses' as obj, count(*)::text as rows from public.card_uses
union all
select 'card_grants', count(*)::text from public.card_grants;

\echo ''
\echo '== 有加分卡余额、且可用于加分的答卷（dry run：不写库，只看会不会命中）=='
-- ⚠ 这里只列出「有 bonus 卡余额的学生 + 其已提交答卷 + 该卷满分」，不实际执行 use_bonus_card
with bal as (
  select g.user_id,
         count(*) - (select count(*) from public.card_uses u
                      where u.user_id = g.user_id and u.kind = 'bonus') as bonus_left
    from public.card_grants g
   where g.kind = 'bonus'
   group by g.user_id
)
select left(b.user_id::text, 8) as uid8, b.bonus_left,
       count(s.id)::text as submitted_papers
  from bal b
  left join public.quiz_submissions s
    on s.user_id = b.user_id and s.status = 'submitted'
 group by 1, 2
 order by 2 desc, 1
 limit 20;
