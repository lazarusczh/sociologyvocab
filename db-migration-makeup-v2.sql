-- ============================================================================
-- 补签规则 v2：从「当周赚当周用」改为「补签卡」（《练级与奖励体系方案》§4.3）
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f db-migration-makeup-v2.sql
--
-- 前置：先跑 `db-migration-cards.sql`（卡流水与余额）。
-- 幂等，可重复执行。
--
-- ---------------------------------------------------------------------------
-- 改了什么，以及为什么
--
-- 旧规则（`db-migration-makeup.sql`）：只允许补「**本周内、早于今天**」的漏签日，
--   且「本周达标」只能换一次**当周**机会 —— 本周若全勤（无漏签日可补），机会直接作废。
--   代价写进了 §4.3：**努力拿不到实际好处，激励被浪费**。
--
-- 新规则（§4.3 教师 2026-09-20 定稿）：
--   · **可补最近 30 天**内的漏签日（更久远的连续记录早已断掉，补了也没有意义）；
--   · 用**卡**，卡**不过期、不设上限**，来源是每周达标与等级里程碑（在 cards 脚本里发）；
--   · **无卡不可补**；成功时扣 1 张。
--
-- ⚠ 因此必须**删掉 `checkin_makeups` 上的 `unique(user_id, week_start)`** ——
--   那是「一周只能补一次」这条旧规则的载体。留着它，学生攒了 5 张卡却一次只能补一天。
--   主键 `(user_id, day_key)` 保留（同一天当然只能补一次）。
--
-- ⚠ `week_start` 字段保留但**语义微调**：旧版填「动作周」（因为只补本周，两者相等），
--   新版填「**被补那天所在周的周一**」。既然不再有"一周一次"的限制，前者已无意义，
--   而后者仍可用于展示（"这一周补上了几天"）。
-- ============================================================================

-- ============================================================================
-- ① 删掉「一周只能补一次」的唯一约束
-- ============================================================================
do $$
declare v_con text;
begin
  select con.conname into v_con
    from pg_constraint con
   where con.conrelid = 'public.checkin_makeups'::regclass
     and con.contype = 'u'
     and pg_get_constraintdef(con.oid) like '%user_id, week_start%';
  if v_con is not null then
    execute format('alter table public.checkin_makeups drop constraint %I', v_con);
    raise notice 'dropped one-per-week constraint: %', v_con;
  else
    raise notice 'one-per-week constraint already absent';
  end if;
end $$;

-- ============================================================================
-- ② apply_makeup()：30 天窗口 + 扣卡
-- ============================================================================
create or replace function public.apply_makeup(p_day_key date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date;
  v_bal   integer;
  v_chk   record;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_day_key is null then
    raise exception 'p_day_key is required';
  end if;

  -- 「今天」按 Asia/Shanghai 取，与 day_key 同源
  v_today := (now() at time zone 'Asia/Shanghai')::date;

  -- 1) 只能补今天以前
  if p_day_key >= v_today then
    return jsonb_build_object('ok', false, 'reason', 'not_past_day');
  end if;

  -- 2) 只能补最近 30 天（§4.3）
  if p_day_key < v_today - 30 then
    return jsonb_build_object('ok', false, 'reason', 'too_old', 'limit_days', 30);
  end if;

  -- 3) 该天尚未达标（达标 = 题数 ≥20 且时长 ≥10 分钟；已补签也算）
  select * into v_chk from public.daily_study_of(v_uid, p_day_key, p_day_key) limit 1;
  if found then
    if v_chk.makeup then
      return jsonb_build_object('ok', false, 'reason', 'already_made_up');
    end if;
    if v_chk.questions >= 20 and v_chk.ms >= 600 * 1000 then
      return jsonb_build_object('ok', false, 'reason', 'already_checked');
    end if;
  end if;

  -- 4) 有卡才能补（无卡不可补；卡不够时把余额一并回给前端，便于提示）
  perform public.grant_pending_cards(v_uid);
  select count(*) into v_bal
    from public.card_grants g
   where g.user_id = v_uid and g.kind = 'makeup';
  v_bal := v_bal - (select count(*) from public.checkin_makeups m where m.user_id = v_uid);
  if v_bal <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_cards', 'balance', 0);
  end if;

  -- 5) 落库。`on conflict do nothing` 兜住并发下的重复提交（主键是 user_id+day_key）
  insert into public.checkin_makeups (user_id, day_key, week_start)
  values (v_uid, p_day_key, date_trunc('week', p_day_key)::date)
  on conflict (user_id, day_key) do nothing;

  return jsonb_build_object('ok', true, 'day_key', p_day_key, 'balance', greatest(0, v_bal - 1));
end $$;

grant execute on function public.apply_makeup(date) to authenticated;

comment on function public.apply_makeup(date) is
  '补签（v2：补签卡模型）。可补最近 30 天内的漏签日；无卡不可补；成功时扣 1 张（余额 = 发放 − checkin_makeups 条数，现算）。';

-- ============================================================================
-- ③ 复核
-- ============================================================================
\echo '== checkin_makeups 上的唯一约束（应只剩主键 user_id+day_key）=='
select con.conname, pg_get_constraintdef(con.oid) as def
  from pg_constraint con
 where con.conrelid = 'public.checkin_makeups'::regclass
 order by con.contype;

\echo ''
\echo '== 卡系统对象是否存在 =='
select 'card_grants' as obj, count(*)::text as rows from public.card_grants
union all
select 'card_uses', count(*)::text from public.card_uses;

\echo ''
\echo '== 等级换算式对账（应与前端 xpLevel.ts 一致：LV2=120 / LV5=540 / LV10=1440 / LV20=3990）=='
select k as level, public.xp_for_level(k) as need_xp, public.xp_level(public.xp_for_level(k)) as round_trip
  from generate_series(1, 20) as g(k);
