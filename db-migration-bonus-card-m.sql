-- ============================================================================
-- 修 `use_bonus_card()` 的真实满分算法：补上纵横填字（crossword）
--
-- 背景（2026-11-03 发现）：
--   `db-migration-bonus-card.sql:91-102` 算 M 时只处理了 matching（按对数），
--   **漏了 crossword**。而前端 `totalPoints()`（app/src/lib/quiz.ts:213-219）
--   从 2026-10-20 起对填字块是「按线索数计分」（每个词 1 分）。
--
--   实测差异（真实卷 `A2 Education Week 9 (Mid-term)`，id e8b6357a-…）：
--     SQL 算法 M = 36 ；前端 totalPoints() M = 40
--   ⇒ 含填字块的作业，加分卡加分被算少（10% 的基数偏小）。
--
-- 为什么现在改：`card_uses` 目前是 **0 行**（加分卡首张在 LV20 / 3990 XP，
--   学生尚未获得）⇒ 没有任何历史卡被按旧算法发过 ⇒ **零迁移风险**。
--   等卡真正发出去之后再改，就得回算历史 `card_bonus` 了。
--
-- 顺带把 M 的算法抽成 `public.quiz_max_points(uuid)` —— 此前它是被内联在两个
-- 函数里的，改一处就容易漏另一处（本次正是这么漏的）。此后 SQL 侧只有这一份。
--
-- 幂等，可重复执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. SQL 侧唯一的满分算法（与前端 totalPoints() 同口径）
--    matching → 对数；crossword → 线索数；其余 → 每题 1 分
-- ---------------------------------------------------------------------------
create or replace function public.quiz_max_points(p_quiz_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(
           case
             when (e.q ->> 'type') = 'matching'
               and jsonb_typeof(e.q -> 'pairs') = 'array'
             then jsonb_array_length(e.q -> 'pairs')
             when (e.q ->> 'type') = 'crossword'
               and jsonb_typeof(e.q -> 'crossword' -> 'clues') = 'array'
             then jsonb_array_length(e.q -> 'crossword' -> 'clues')
             else 1
           end), 0)::integer
    from public.quizzes z
    cross join lateral jsonb_array_elements(coalesce(z.questions, '[]'::jsonb)) as e(q)
   where z.id = p_quiz_id;
$$;

comment on function public.quiz_max_points(uuid) is
  '试卷真实满分（评分点数）。与前端 totalPoints() 同口径：matching 按对数、crossword 按线索数、其余每题 1 分。';

-- ---------------------------------------------------------------------------
-- 2. 重定义 use_bonus_card：M 改用 quiz_max_points
--    ⚠ 函数体其余部分与 db-migration-bonus-card.sql:44-150 **逐字一致**，
--      只把算 M 的那段 select 换掉。不要顺手改别的。
-- ---------------------------------------------------------------------------
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

  -- 真实满分（含填字块）：唯一实现见 public.quiz_max_points()
  v_M := public.quiz_max_points(v_sub.quiz_id);

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

-- ============================================================================
-- 复核
-- ============================================================================
\echo '== 1) quiz_max_points 已建 =='
select p.proname, pg_get_function_result(p.oid) as returns
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public' and p.proname = 'quiz_max_points';

\echo ''
\echo '== 2) 含填字块的卷：SQL 满分现在应与前端 totalPoints() 一致（40，此前是 36）=='
select z.id, left(z.title, 30) as title,
       public.quiz_max_points(z.id) as max_points_fixed
  from public.quizzes z
 where exists (
   select 1 from jsonb_array_elements(coalesce(z.questions,'[]'::jsonb)) e
    where (e ->> 'type') = 'crossword')
 order by z.created_at desc
 limit 5;

\echo ''
\echo '== 3) card_uses 当前行数（应仍为 0 —— 确认改 M 没有历史影响）=='
select count(*) as card_uses_rows from public.card_uses;
