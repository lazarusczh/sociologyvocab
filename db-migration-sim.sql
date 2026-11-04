-- ============================================
-- 模拟调研（课堂活动新类型 sim）
--
-- 阶段：lobby（点名，不分组）→ grouped（教师点「开始分组」）→ frozen（班级问卷定稿）
--       → answered（三人格投喂完成）→ reveal（逐题揭晓）
--
-- 设计要点：
--   * 复用 live_sessions / live_participants / live_events，只加 kind='sim'
--   * 学生只写「自己的题」，队友只读，教师可改（见 RLS + RPC）
--   * 人设卡存 sim_personas，**仅教师可读**；卡片内容不得进入公开仓库，
--     由本地不提交的 SQL 单独灌入（见文件末尾说明）
--   * 答案与内心分表：RLS 只按行过滤，同一 jsonb 里做不到「一列给学生、一列藏起来」
--   * 实时只推信号：sim_group_questions / sim_papers / sim_persona_answers / sim_reveals
--     **sim_persona_inner 与 sim_personas 不进 publication**
--
-- 幂等，可重复执行。未在本文件里做任何删除历史数据的操作。
-- ============================================

-- --------------------------------------------
-- 0. 放宽 kind：spell / guess / oral / sim
--    ⚠ 四个值必须写全，否则线上口头速答会一起坏
-- --------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'live_sessions_kind_check') then
    alter table public.live_sessions drop constraint live_sessions_kind_check;
  end if;
  alter table public.live_sessions
    add constraint live_sessions_kind_check check (kind in ('spell', 'guess', 'oral', 'sim'));
end $$;

-- --------------------------------------------
-- 1. 分组
-- --------------------------------------------
create table if not exists public.sim_groups (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  group_no int not null,
  created_at timestamptz not null default now(),
  unique (session_id, group_no)
);

-- 参与者挂到组上。刻意不加唯一索引 (session_id,user_id)：
-- 历史数据可能已有重复行，唯一索引会让迁移失败；去重交给 RPC（advisory lock + 取最新）
alter table public.live_participants add column if not exists group_id uuid;

-- --------------------------------------------
-- 2. 组内草稿：一题一行（作者唯一可改，队友只读）
-- --------------------------------------------
create table if not exists public.sim_group_questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  group_id uuid not null,
  author_id uuid not null,
  qtype text not null check (qtype in ('single', 'multi', 'scale')),
  stem text not null,
  options jsonb not null default '[]'::jsonb,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sim_group_questions_session on public.sim_group_questions (session_id);
create index if not exists sim_group_questions_group on public.sim_group_questions (group_id);

-- --------------------------------------------
-- 3. 班级问卷（冻结快照，唯一权威）
-- --------------------------------------------
create table if not exists public.sim_papers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  version int not null default 1,
  items jsonb not null,
  frozen_at timestamptz not null default now(),
  frozen_by uuid,
  unique (session_id, version)
);

-- --------------------------------------------
-- 4. 人设卡（仅教师可读；内容不随仓库发布）
-- --------------------------------------------
create table if not exists public.sim_personas (
  id uuid primary key default gen_random_uuid(),
  pack text not null default 'unpaid_labour',
  order_no int not null default 1,
  name text not null,
  card jsonb not null,
  created_at timestamptz not null default now(),
  unique (pack, order_no)
);

-- --------------------------------------------
-- 5. 答案（全班可读）与内心（仅教师）
-- --------------------------------------------
create table if not exists public.sim_persona_answers (
  session_id uuid not null,
  paper_version int not null,
  persona_id uuid not null,
  answers jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, paper_version, persona_id)
);

create table if not exists public.sim_persona_inner (
  session_id uuid not null,
  paper_version int not null,
  persona_id uuid not null,
  inner_json jsonb not null,   -- 列名不能叫 inner（PostgreSQL 保留字）
  closing text,
  raw jsonb,
  created_at timestamptz not null default now(),
  primary key (session_id, paper_version, persona_id)
);

-- --------------------------------------------
-- 6. 揭晓进度（先答案、后内心）
-- --------------------------------------------
create table if not exists public.sim_reveals (
  session_id uuid not null,
  qid text not null,
  stage text not null check (stage in ('answers', 'inner')),
  revealed_at timestamptz not null default now(),
  primary key (session_id, qid, stage)
);

-- ============================================
-- RLS
--   读写都尽量走 RPC（security definer）；策略只保证「该看见的能看见」
-- ============================================
alter table public.sim_groups enable row level security;
alter table public.sim_group_questions enable row level security;
alter table public.sim_papers enable row level security;
alter table public.sim_personas enable row level security;
alter table public.sim_persona_answers enable row level security;
alter table public.sim_persona_inner enable row level security;
alter table public.sim_reveals enable row level security;

-- sim_groups：全班可读；教师可改
drop policy if exists "sim_groups_read" on public.sim_groups;
create policy "sim_groups_read" on public.sim_groups
  for select using (auth.role() = 'authenticated');
drop policy if exists "sim_groups_teacher" on public.sim_groups;
create policy "sim_groups_teacher" on public.sim_groups
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- sim_group_questions：全班可读（队友要看见彼此的题）；写入只走 RPC，教师可改
drop policy if exists "sim_group_questions_read" on public.sim_group_questions;
create policy "sim_group_questions_read" on public.sim_group_questions
  for select using (auth.role() = 'authenticated');
drop policy if exists "sim_group_questions_teacher" on public.sim_group_questions;
create policy "sim_group_questions_teacher" on public.sim_group_questions
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- sim_papers：全班可读（阶段 2 要展示题目）；写入走 RPC
drop policy if exists "sim_papers_read" on public.sim_papers;
create policy "sim_papers_read" on public.sim_papers
  for select using (auth.role() = 'authenticated');
drop policy if exists "sim_papers_teacher" on public.sim_papers;
create policy "sim_papers_teacher" on public.sim_papers
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- sim_personas：只有教师（无学生策略 = 学生读不到）
drop policy if exists "sim_personas_teacher" on public.sim_personas;
create policy "sim_personas_teacher" on public.sim_personas
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- sim_persona_answers：全班可读（阶段 2）；写入走 RPC
drop policy if exists "sim_persona_answers_read" on public.sim_persona_answers;
create policy "sim_persona_answers_read" on public.sim_persona_answers
  for select using (auth.role() = 'authenticated');
drop policy if exists "sim_persona_answers_teacher" on public.sim_persona_answers;
create policy "sim_persona_answers_teacher" on public.sim_persona_answers
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- sim_persona_inner：只有教师（绝不给学生，哪怕已揭晓——揭晓走投屏）
drop policy if exists "sim_persona_inner_teacher" on public.sim_persona_inner;
create policy "sim_persona_inner_teacher" on public.sim_persona_inner
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- sim_reveals：全班可读（学生端要知道「答案/内心已公布」）
drop policy if exists "sim_reveals_read" on public.sim_reveals;
create policy "sim_reveals_read" on public.sim_reveals
  for select using (auth.role() = 'authenticated');
drop policy if exists "sim_reveals_teacher" on public.sim_reveals;
create policy "sim_reveals_teacher" on public.sim_reveals
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- ============================================
-- 实时发布（只推信号；inner 与 personas 刻意不加）
-- ============================================
do $$
declare
  t text;
begin
  foreach t in array array['sim_groups', 'sim_group_questions', 'sim_papers',
                           'sim_persona_answers', 'sim_reveals']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================
-- RPC 1：加入点名（不分组）
-- ============================================
create or replace function public.sim_join_lobby(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_kind text;
  v_state text;
  v_phase text;
  v_config jsonb;
  v_pid uuid;
  v_name text;
  v_count int;
  v_gid uuid;
  v_gno int;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select s.kind, s.state, coalesce(s.config, '{}'::jsonb)
    into v_kind, v_state, v_config
  from public.live_sessions s
  where s.id = p_session_id;

  if not found then
    raise exception 'session not found';
  end if;
  if v_kind <> 'sim' then
    raise exception 'not a sim session';
  end if;
  if v_state <> 'running' then
    raise exception 'session not running';
  end if;

  v_phase := coalesce(v_config->>'phase', 'lobby');

  -- 同一人连点两次也不会多出一行
  perform pg_advisory_xact_lock(hashtext(p_session_id::text || ':' || v_uid::text));

  select p.id into v_pid
  from public.live_participants p
  where p.session_id = p_session_id and p.user_id = v_uid
  order by p.joined_at desc nulls last, p.id
  limit 1;

  if v_pid is null then
    select u.raw_user_meta_data->>'name' into v_name
    from auth.users u where u.id = v_uid;

    insert into public.live_participants (session_id, user_id, name)
    values (p_session_id, v_uid, v_name)
    returning id into v_pid;
  else
    update public.live_participants set last_seen = now() where id = v_pid;
  end if;

  -- 已经分过组（迟到）：塞进人数最少的组，教师端会提示
  if v_phase in ('grouped', 'frozen', 'answered', 'reveal') then
    select p.group_id into v_gid from public.live_participants p where p.id = v_pid;
    if v_gid is null then
      select g.id, g.group_no into v_gid, v_gno
      from public.sim_groups g
      left join public.live_participants q on q.group_id = g.id
      where g.session_id = p_session_id
      group by g.id, g.group_no
      order by count(q.id), g.group_no
      limit 1;
      if v_gid is not null then
        update public.live_participants set group_id = v_gid where id = v_pid;
      end if;
    else
      select g.group_no into v_gno from public.sim_groups g where g.id = v_gid;
    end if;
  end if;

  select count(distinct p.user_id) into v_count
  from public.live_participants p where p.session_id = p_session_id;

  return jsonb_build_object(
    'participant_id', v_pid,
    'phase', v_phase,
    'joined', v_count,
    'group_id', v_gid,
    'group_no', v_gno
  );
end $$;

-- ============================================
-- RPC 2：教师点「开始分组」——先打乱，再轮转发牌
--        各组人数差 ≤ 1；已在编辑则拒绝（除非一题都还没有，允许重分）
-- ============================================
create or replace function public.sim_assign_groups(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_config jsonb;
  v_phase text;
  v_target int;
  v_n int;
  v_k int;
  v_result jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.user_roles r where r.user_id = v_uid and r.role = 'teacher') then
    raise exception 'teacher only';
  end if;

  select coalesce(s.config, '{}'::jsonb) into v_config
  from public.live_sessions s
  where s.id = p_session_id and s.kind = 'sim' and s.state = 'running';
  if not found then raise exception 'sim session not running'; end if;

  v_phase := coalesce(v_config->>'phase', 'lobby');
  if v_phase not in ('lobby', 'grouped') then
    raise exception 'cannot regroup at phase %', v_phase;
  end if;
  if exists (select 1 from public.sim_group_questions q where q.session_id = p_session_id) then
    raise exception 'students already wrote questions';
  end if;

  perform pg_advisory_xact_lock(hashtext('sim-assign:' || p_session_id::text));

  select count(distinct p.user_id) into v_n
  from public.live_participants p where p.session_id = p_session_id;
  if v_n = 0 then raise exception 'nobody joined yet'; end if;

  v_target := greatest(2, least(10, coalesce((v_config->>'targetGroupSize')::int, 5)));
  v_k := ceil(v_n::numeric / v_target)::int;

  -- 重分：先断开旧归属，再删旧组（此时保证没有任何题目）
  update public.live_participants set group_id = null where session_id = p_session_id;
  delete from public.sim_groups where session_id = p_session_id;

  insert into public.sim_groups (session_id, group_no)
  select p_session_id, gs from generate_series(1, v_k) as gs;

  with latest as (
    select distinct on (p.user_id) p.id
    from public.live_participants p
    where p.session_id = p_session_id
    order by p.user_id, p.joined_at desc nulls last, p.id
  ), ranked as (
    select id, row_number() over (order by random()) as rn from latest
  )
  update public.live_participants lp
  set group_id = g.id
  from ranked r
  join public.sim_groups g
    on g.session_id = p_session_id and g.group_no = ((r.rn - 1) % v_k) + 1
  where lp.id = r.id;

  update public.live_sessions
  set config = jsonb_set(coalesce(config, '{}'::jsonb), '{phase}', '"grouped"')
  where id = p_session_id;

  select jsonb_agg(x) into v_result from (
    select jsonb_build_object(
      'group_no', g.group_no,
      'members', coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'user_id', p.user_id))
                          filter (where p.id is not null), '[]'::jsonb)
    ) as x
    from public.sim_groups g
    left join public.live_participants p on p.group_id = g.id
    where g.session_id = p_session_id
    group by g.group_no
    order by g.group_no
  ) s;

  return jsonb_build_object('groups', v_k, 'joined', v_n, 'detail', coalesce(v_result, '[]'::jsonb));
end $$;

-- ============================================
-- RPC 3：保存/修改自己的一道题（作者本人；教师可改任何题）
-- ============================================
create or replace function public.sim_save_question(
  p_session_id uuid,
  p_question_id uuid,
  p_qtype text,
  p_stem text,
  p_options jsonb,
  p_position int default 0
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_teacher boolean;
  v_phase text;
  v_limit int;
  v_gid uuid;
  v_owner uuid;
  v_qid uuid;
  v_n int;
  v_opt_count int;
  v_bad text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select exists (select 1 from public.user_roles r where r.user_id = v_uid and r.role = 'teacher')
    into v_teacher;

  select coalesce(s.config->>'phase', 'lobby'),
         coalesce((s.config->>'perGroupLimit')::int, 3)
    into v_phase, v_limit
  from public.live_sessions s
  where s.id = p_session_id and s.kind = 'sim' and s.state = 'running';
  if not found then raise exception 'sim session not running'; end if;

  if v_phase <> 'grouped' then
    raise exception 'not in editing phase';
  end if;
  v_limit := greatest(1, least(10, v_limit));

  if p_qtype not in ('single', 'multi', 'scale') then
    raise exception 'bad qtype';
  end if;
  if char_length(btrim(coalesce(p_stem, ''))) < 6 or char_length(btrim(p_stem)) > 80 then
    raise exception 'stem length must be 6..80';
  end if;

  -- 选项校验
  if jsonb_typeof(p_options) <> 'array' then
    raise exception 'options must be an array';
  end if;
  v_opt_count := jsonb_array_length(p_options);
  if p_qtype = 'scale' then
    if v_opt_count not in (3, 5, 7) then
      raise exception 'scale must have 3, 5 or 7 points';
    end if;
  else
    if v_opt_count < 2 or v_opt_count > 6 then
      raise exception 'single/multi need 2..6 options';
    end if;
  end if;

  select string_agg(distinct btrim(e->>'label'), ',') into v_bad
  from jsonb_array_elements(p_options) e
  where char_length(btrim(coalesce(e->>'label', ''))) > 16;
  if v_bad is not null then raise exception 'option too long: %', v_bad; end if;

  -- 选项 key 必须唯一且非空（前端用 A/B/C 或 1..N）
  if (select count(distinct coalesce(e->>'key', '')) from jsonb_array_elements(p_options) e) <> v_opt_count
     or exists (select 1 from jsonb_array_elements(p_options) e where coalesce(e->>'key', '') = '') then
    raise exception 'option keys must be unique and non-empty';
  end if;

  if p_question_id is null then
    -- 新增：必须先分组
    select p.group_id into v_gid
    from public.live_participants p
    where p.session_id = p_session_id and p.user_id = v_uid
    order by p.joined_at desc nulls last limit 1;
    if v_gid is null then raise exception 'not grouped yet'; end if;

    -- 上限按「组」算
    select count(*) into v_n from public.sim_group_questions q where q.group_id = v_gid;
    if v_n >= v_limit then raise exception 'group reached limit %', v_limit; end if;

    insert into public.sim_group_questions
      (session_id, group_id, author_id, qtype, stem, options, position)
    values
      (p_session_id, v_gid, v_uid, p_qtype, btrim(p_stem), p_options, coalesce(p_position, 0))
    returning id into v_qid;
  else
    select q.author_id into v_owner
    from public.sim_group_questions q
    where q.id = p_question_id and q.session_id = p_session_id;
    if not found then raise exception 'question not found'; end if;
    if v_owner <> v_uid and not v_teacher then raise exception 'not your question'; end if;

    update public.sim_group_questions
    set qtype = p_qtype,
        stem = btrim(p_stem),
        options = p_options,
        position = coalesce(p_position, position),
        updated_at = now()
    where id = p_question_id
    returning id into v_qid;
  end if;

  return jsonb_build_object('id', v_qid);
end $$;

-- ============================================
-- RPC 4：删除一道题（作者或教师；冻结后不可删）
-- ============================================
create or replace function public.sim_delete_question(p_session_id uuid, p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_teacher boolean;
  v_phase text;
  v_owner uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select exists (select 1 from public.user_roles r where r.user_id = v_uid and r.role = 'teacher') into v_teacher;

  select coalesce(s.config->>'phase', 'lobby') into v_phase
  from public.live_sessions s where s.id = p_session_id;
  if v_phase <> 'grouped' then raise exception 'not in editing phase'; end if;

  select q.author_id into v_owner from public.sim_group_questions q
  where q.id = p_question_id and q.session_id = p_session_id;
  if not found then raise exception 'question not found'; end if;
  if v_owner <> v_uid and not v_teacher then raise exception 'not your question'; end if;

  delete from public.sim_group_questions where id = p_question_id;
end $$;

-- ============================================
-- RPC 5：冻结班级问卷
--   p_items 由教师端提交（选中的题 + 可能的润色），每题必须指向本场真实题目
-- ============================================
create or replace function public.sim_freeze_paper(p_session_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_phase text;
  v_n int;
  v_version int;
  v_bad text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.user_roles r where r.user_id = v_uid and r.role = 'teacher') then
    raise exception 'teacher only';
  end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'items must be an array'; end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 or v_n > 8 then raise exception 'paper must have 1..8 items'; end if;

  select coalesce(s.config->>'phase', 'lobby') into v_phase
  from public.live_sessions s where s.id = p_session_id and s.kind = 'sim';
  if not found then raise exception 'sim session not found'; end if;
  if v_phase <> 'grouped' then raise exception 'not in editing phase'; end if;

  -- 每题结构（qid/qtype/stem/options）
  select string_agg(coalesce(e->>'qid', '?'), ',') into v_bad
  from jsonb_array_elements(p_items) e
  where coalesce(e->>'qid', '') = ''
     or coalesce(e->>'qtype', '') not in ('single', 'multi', 'scale')
     or char_length(btrim(coalesce(e->>'stem', ''))) < 6
     or jsonb_typeof(e->'options') is distinct from 'array';
  if v_bad is not null then raise exception 'bad item(s): %', v_bad; end if;

  -- 选项数量：量表 3/5/7，其余 2..6
  select string_agg(coalesce(e->>'qid', '?'), ',') into v_bad
  from jsonb_array_elements(p_items) e
  where case when e->>'qtype' = 'scale'
             then jsonb_array_length(e->'options') not in (3, 5, 7)
             else jsonb_array_length(e->'options') < 2 or jsonb_array_length(e->'options') > 6
        end;
  if v_bad is not null then raise exception 'bad option count for %', v_bad; end if;

  -- 每个 qid 必须真实存在于本场的组内题目里（防止前端编题）
  select string_agg(distinct e->>'qid', ',') into v_bad
  from jsonb_array_elements(p_items) e
  where not exists (
    select 1 from public.sim_group_questions q
    where q.session_id = p_session_id and q.id::text = (e->>'qid')
  );
  if v_bad is not null then raise exception 'unknown qid(s): %', v_bad; end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.sim_papers where session_id = p_session_id;

  insert into public.sim_papers (session_id, version, items, frozen_by)
  values (p_session_id, v_version, p_items, v_uid);

  update public.live_sessions
  set config = jsonb_set(coalesce(config, '{}'::jsonb), '{phase}', '"frozen"')
  where id = p_session_id;

  return jsonb_build_object('version', v_version, 'items', v_n);
end $$;

-- ============================================
-- RPC 6：写入一个人格的答案 + 内心（一个事务，缺一不可）
-- ============================================
create or replace function public.sim_store_persona_result(
  p_session_id uuid,
  p_version int,
  p_persona_id uuid,
  p_answers jsonb,
  p_inner jsonb,
  p_closing text,
  p_raw jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_items jsonb;
  v_bad text;
  v_have int;
  v_need int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.user_roles r where r.user_id = v_uid and r.role = 'teacher') then
    raise exception 'teacher only';
  end if;

  select p.items into v_items
  from public.sim_papers p
  where p.session_id = p_session_id and p.version = p_version;
  if not found then raise exception 'paper not found'; end if;

  -- 每题都必须有答案（或明确 skipped），且取值必须落在选项内
  select string_agg(x->>'qid', ',') into v_bad
  from jsonb_array_elements(v_items) x
  where not exists (
    select 1
    from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a
    where a->>'qid' = (x->>'qid')
      and (
        (a ? 'skipped' and (a->>'skipped')::boolean)
        or ((x->>'qtype') = 'multi' and jsonb_typeof(a->'value') = 'array'
            and not exists (
              select 1 from jsonb_array_elements(a->'value') v
              where not exists (
                select 1 from jsonb_array_elements(x->'options') o where o->>'key' = (v #>> '{}')
              )
            ))
        or ((x->>'qtype') = 'scale'
            and (a->>'value') ~ '^[0-9]+$'
            and (a->>'value')::int between 1 and jsonb_array_length(x->'options'))
        or exists (select 1 from jsonb_array_elements(x->'options') o where o->>'key' = (a->>'value'))
      )
  );
  if v_bad is not null then raise exception 'missing or invalid answer for %', v_bad; end if;

  insert into public.sim_persona_answers (session_id, paper_version, persona_id, answers)
  values (p_session_id, p_version, p_persona_id, p_answers)
  on conflict (session_id, paper_version, persona_id)
  do update set answers = excluded.answers, created_at = now();

  insert into public.sim_persona_inner (session_id, paper_version, persona_id, inner_json, closing, raw)
  values (p_session_id, p_version, p_persona_id, coalesce(p_inner, '[]'::jsonb), p_closing, p_raw)
  on conflict (session_id, paper_version, persona_id)
  do update set inner_json = excluded.inner_json, closing = excluded.closing, raw = excluded.raw, created_at = now();

  -- 三人齐了才把阶段推到 answered
  select count(*) into v_have from public.sim_persona_answers a
  where a.session_id = p_session_id and a.paper_version = p_version;
  select count(*) into v_need
  from public.sim_personas pe
  where pe.pack = coalesce(
    (select s.config->>'pack' from public.live_sessions s where s.id = p_session_id),
    'unpaid_labour'
  );

  if v_need > 0 and v_have >= v_need then
    update public.live_sessions
    set config = jsonb_set(coalesce(config, '{}'::jsonb), '{phase}', '"answered"')
    where id = p_session_id;
  end if;

  return jsonb_build_object('answers', v_have, 'needed', v_need);
end $$;

-- ============================================
-- RPC 7：揭晓（一次只推进一步：answers 或 inner）
-- ============================================
create or replace function public.sim_reveal(
  p_session_id uuid,
  p_qid text,
  p_stage text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_phase text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.user_roles r where r.user_id = v_uid and r.role = 'teacher') then
    raise exception 'teacher only';
  end if;
  if p_stage not in ('answers', 'inner') then raise exception 'bad stage'; end if;

  select coalesce(s.config->>'phase', 'lobby') into v_phase
  from public.live_sessions s where s.id = p_session_id;
  if v_phase not in ('answered', 'reveal') then raise exception 'not ready to reveal'; end if;

  -- 先答案后内心：inner 必须在 answers 之后
  if p_stage = 'inner' and not exists (
    select 1 from public.sim_reveals r
    where r.session_id = p_session_id and r.qid = p_qid and r.stage = 'answers'
  ) then
    raise exception 'reveal answers first';
  end if;

  insert into public.sim_reveals (session_id, qid, stage)
  values (p_session_id, p_qid, p_stage)
  on conflict (session_id, qid, stage) do nothing;

  if v_phase = 'answered' then
    update public.live_sessions
    set config = jsonb_set(coalesce(config, '{}'::jsonb), '{phase}', '"reveal"')
    where id = p_session_id;
  end if;
end $$;

-- ============================================
-- 附：人设卡怎么灌（不要在公开仓库里写卡片内容）
--
--   仓库是公开的，卡片一旦写进 db-migration-*.sql 就等于公开。做法：
--   1) 本地写 db-seed-sim-personas.local.sql（已 gitignore），内容形如：
--        insert into public.sim_personas (pack, order_no, name, card) values
--          ('unpaid_labour', 1, '李阿姨', '{...}'::jsonb), ...
--        on conflict (pack, order_no) do update set name = excluded.name, card = excluded.card;
--   2) psql -w -v ON_ERROR_STOP=1 -f db-seed-sim-personas.local.sql
--   3) 校验：以学生身份的 JWT 查 select * from sim_personas; 应当返回 0 行
--
--   .gitignore 需要加一行：db-seed-sim-personas.local.sql
-- ============================================
