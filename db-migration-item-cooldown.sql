-- ============================================================================
-- 抬高「同题去重」门槛：60 秒内同 item 收满 5 条之后才置疑（2026-10-08 教师裁定）
--
-- 用法：psql -h <host> -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--        -f db-migration-item-cooldown.sql
--
-- 改了什么：submit_xp_events() 的防线 #5，由「60 秒内同 item **存在一条**就拒收」
--   改为「60 秒内同 item 已收满 **5 条**才拒收」。其余逻辑一字未动。
--
-- 为什么：**日常练习是随机抽题的，同一题号重复出现是正常现象**
--   （教师 2026-10-08 指出）。旧门槛会把正常作答判成 same_item_too_soon 并**整条丢弃**，
--   后果有两层：① 少算 XP；② **少算打卡题数** —— 而打卡题数是达标门槛之一，
--   于是学生的达标被一条防刷分规则悄悄拿掉。
--   实测（假期七天）：9 天出现「本地题数 > 服务端题数」，每次少 1~2 题。
--
-- ⚠ 刷分的收益本来就有上限：**XP 有每日 400 的上限**（xp_of 之外的日限逻辑），
--   所以抬高这条门槛不会开出无界漏洞；留一条过紧的冷却只会误伤正常练习。
--   现在被拒的是「同一题 60 秒内第 6 次作答」，那才是不正常的行为。
--
-- ⚠ 只影响**此后**上报的事件，不改历史数据。函数整体替换，可重复执行。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_xp_events(p_events jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid        uuid := auth.uid();
  v_n          int;
  v_rec        record;
  v_floor      date;
  v_day        date;
  v_ms         integer;
  v_xp         integer;
  v_used       integer;
  v_accepted   int := 0;
  v_duplicated int := 0;
  v_rejected   jsonb := '[]'::jsonb;
  v_all_same   boolean := false;
  v_first_ms   integer;
  v_ms_count   int := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'p_events must be a json array';
  end if;

  select count(*) into v_n from jsonb_array_elements(p_events);
  if v_n > 100 then
    raise exception 'too many events in one call (max 100)';
  end if;
  if v_n = 0 then
    return jsonb_build_object('accepted', 0, 'duplicated', 0, 'rejected', '[]'::jsonb);
  end if;

  -- 防线 #2 允许的最早日期：本月 1 日；若今天是月初 1~3 号，则再往前放一个月
  v_floor := date_trunc('month', (now() at time zone 'Asia/Shanghai'))::date;
  if extract(day from (now() at time zone 'Asia/Shanghai')) <= 3 then
    v_floor := (v_floor - interval '1 month')::date;
  end if;

  -- 防线 #9 预扫描：疑似脚本批量刷分。
  --
  -- ⚠ 判据必须**同时**满足「用时全相同」与「用时贴着下限」两个条件
  --   （2026-09-23 接入客户端时修正）：
  --   客户端对**批量提交**的题型（填空 / 填字 / 作业 / 订正）采用**均摊**——
  --   一批事件的用时天然全相同，那是正常行为，不是刷分。
  --   而脚本刷分除了全同，还会贴着客户端下限：服务端会把 < 500ms 截断成 500，
  --   所以刷出来的批次清一色是 500。均摊出的真实用时（整段 ÷ 空数）基本在数秒以上。
  --   故加上 `v_first_ms <= 500` 这一条，避免把正常均摊误标为异常。
  select count(distinct x.elapsed_ms), min(x.elapsed_ms)
    into v_ms_count, v_first_ms
    from jsonb_to_recordset(p_events) as x(elapsed_ms integer)
   where x.elapsed_ms is not null;
  v_all_same := (v_ms_count = 1) and (v_n > 3) and v_first_ms <= 500;

  for v_rec in
    select * from jsonb_to_recordset(p_events) as x(
      event_id    uuid,
      kind        text,
      item_id     text,
      mode        text,
      correct     boolean,
      score       numeric,
      elapsed_ms  integer,
      answered_at timestamptz,
      session_id  uuid,
      chain_mode  text,
      chain_kind  text
    )
  loop
    -- 必填缺失 ⇒ 拒收（这类是格式错误，不是"学生做得快"）
    if v_rec.event_id is null or v_rec.item_id is null or v_rec.mode is null
       or v_rec.kind is null or v_rec.answered_at is null or v_rec.score is null then
      v_rejected := v_rejected || jsonb_build_object('event_id', v_rec.event_id, 'reason', 'missing_field');
      continue;
    end if;

    -- ★ 防线 #1 幂等 —— **必须排在所有其它检查之前**（2026-09-23 冒烟测试发现）：
    --   若放到后面，重复上报会先撞上「同题去重」而被记为 rejected: same_item_too_soon，
    --   客户端就无法区分「这条我已经收到了」与「这条被永久拒绝」，
    --   补报队列会把已成功的事件当成失败反复重试。返回 duplicated 才是正确语义。
    if exists (
      select 1 from public.xp_events e
       where e.user_id = v_uid and e.event_id = v_rec.event_id
    ) then
      v_duplicated := v_duplicated + 1;
      continue;
    end if;

    -- 防线 #2 补报窗口
    if v_rec.answered_at > now() + interval '5 minutes' then
      v_rejected := v_rejected || jsonb_build_object('event_id', v_rec.event_id, 'reason', 'future_time');
      continue;
    end if;
    if v_rec.answered_at < now() - interval '72 hours' then
      v_rejected := v_rejected || jsonb_build_object('event_id', v_rec.event_id, 'reason', 'too_old');
      continue;
    end if;

    -- 防线 #2b 不落在已结算月份
    v_day := (v_rec.answered_at at time zone 'Asia/Shanghai')::date;
    if v_day < v_floor then
      v_rejected := v_rejected || jsonb_build_object('event_id', v_rec.event_id, 'reason', 'settled_month');
      continue;
    end if;

    -- 防线 #3 模式白名单
    if v_rec.mode not in ('choice','spelling','matching','crossword','cloze','chain','definition') then
      v_rejected := v_rejected || jsonb_build_object('event_id', v_rec.event_id, 'reason', 'bad_mode');
      continue;
    end if;
    if v_rec.kind not in ('answer','chain_complete') then
      v_rejected := v_rejected || jsonb_build_object('event_id', v_rec.event_id, 'reason', 'bad_kind');
      continue;
    end if;

    -- 防线 #4 用时：**下限截断 + 上限丢弃**
    --
    -- 下限：< 500ms ⇒ 按 500ms 计（**截断，不拒收**）—— 学生答得快不是作弊。
    --
    -- ★ 上限：> 30 分钟 ⇒ 记 NULL（**该题用时不可信**）。
    --   为什么必须有上限（2026-09-24 实测发现，此前只有下限）：
    --     `MultipleChoice` 的计时器从「题目呈现」起算，学生若在**题目呈现后离开页面**
    --     （切标签 / 锁屏 / 关掉 / 直接走开），**离开的那段时间会被算进该题**。
    --     实测两条真实记录：6,938,167ms（115.6 分）与 8,820,004ms（147 分），
    --     与它们各自**前一题的 `answered_at` 间隔逐毫秒吻合** —— 正是「离开页面」的时长。
    --   后果：打卡时长**虚高** ⇒ 未达标被算成达标。方向与"口径更严"相反，同样必须堵。
    --   为何置 NULL 而不截断：截断到 30 分钟仍会**计入一段虚假时间**；NULL 表示
    --     「不可信、不计时长」，与「客户端根本没报用时」是**同一语义**，口径干净。
    --   为何选 30 分钟：单题作答不可能超过它；而对 10 分钟打卡门槛来说余量足够大，
    --     不会误伤「在一道难题上真的想了很久」的学生。
    v_ms := v_rec.elapsed_ms;
    if v_ms is not null then
      if v_ms < 500 then
        v_ms := 500;
      elsif v_ms > 1800000 then   -- 30 分钟
        v_ms := null;
      end if;
    end if;

    -- 防线 #5 同题去重：同 item 60 秒内只收一条
    --   ⚠ 仅对 kind='answer' 生效。chain_complete 的 item_id 记的是「起点」，
    --   同一天从同一个起点再开一局是完全正常的行为，不该被去重
    --   （它另有 unique(user_id, session_id) 保证同一局只结算一次）。
    if v_rec.kind = 'answer' and (
      select count(*) from public.xp_events e
       where e.user_id = v_uid
         and e.item_id = v_rec.item_id
         and e.kind    = 'answer'
         and e.answered_at > v_rec.answered_at - interval '60 seconds'
    ) >= 5 then
      v_rejected := v_rejected || jsonb_build_object('event_id', v_rec.event_id, 'reason', 'same_item_too_soon');
      continue;
    end if;

    -- 服务端算分（客户端不得指定 XP）
    v_xp := public.xp_of(
      v_rec.kind, v_rec.mode, greatest(0, least(1, coalesce(v_rec.score, 0))),
      v_rec.chain_mode, v_rec.chain_kind
    );

    -- 防线 #8 每日裁剪：只对练习 XP（本题即全部；教师奖励另表，不计入）
    if v_xp > 0 then
      select coalesce(sum(xp), 0) into v_used
        from public.xp_events
       where user_id = v_uid and day_key = v_day;
      if v_used >= 400 then
        v_xp := 0;
      elsif v_used + v_xp > 400 then
        v_xp := 400 - v_used;
      end if;
    end if;

    -- 写入（防线 #1 幂等 / #6 接龙唯一，都靠唯一索引兜底）
    begin
      insert into public.xp_events (
        user_id, event_id, kind, item_id, mode, correct, score,
        elapsed_ms, answered_at, day_key, session_id,
        chain_mode, chain_kind, xp, suspicious
      ) values (
        v_uid, v_rec.event_id, v_rec.kind, v_rec.item_id, v_rec.mode,
        coalesce(v_rec.correct, false), greatest(0, least(1, coalesce(v_rec.score, 0))),
        v_ms, v_rec.answered_at, v_day, v_rec.session_id,
        v_rec.chain_mode, v_rec.chain_kind, v_xp, v_all_same
      );
      v_accepted := v_accepted + 1;
    exception
      when unique_violation then
        v_duplicated := v_duplicated + 1;
    end;
  end loop;

  return jsonb_build_object(
    'accepted',   v_accepted,
    'duplicated', v_duplicated,
    'rejected',   v_rejected
  );
end $function$

-- ⚠ 授权与注释**必须留在本文件**（2026-10-08 补）：
--   本文件是 `submit_xp_events` 的**最新拥有者**，但原先只重建函数体、没有 `grant`。
--   `create or replace` 会保留既有授权，所以**生产库一直正常**；
--   但**全新安装**时，若 `db-migration-xp-c.sql` 里的旧定义已按同日变更被删除，
--   就再没有任何文件把执行权授予 `authenticated` ⇒ **学生将完全无法上报 XP**。
grant execute on function public.submit_xp_events(jsonb) to authenticated;

comment on function public.submit_xp_events(jsonb) is
  'XP 事件上报（幂等）。九道防线；除补报超窗口外一律接收 —— 宁可少算，不要丢事件。同题去重自 2026-10-08 起为「同 item + 同 kind 收满 5 条才拒」。';

