-- ============================================
-- 实时课堂活动（第一批：拼写竞赛）建表
--
-- 设计与全部口径见项目根《实时多人在线功能规划.md》第七节。
-- 幂等，可重复执行：
--   $env:PGPASSFILE="$env:USERPROFILE\.pgpass"
--   psql $conn -w -v ON_ERROR_STOP=1 -f db-migration-live-spell.sql
--
-- 层次：live_sessions（一场课）→ group_no（回合，全员重置）→ round_no（轮 = 一题）
-- 铁律：术语只放 live_round_secrets（仅教师可读）；判定与结算走 security definer 的 RPC，
--       前端只发意图、不做判定。
-- ============================================

-- 1. 一场课
create table if not exists public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'spell' check (kind in ('spell', 'guess')),
  class_id uuid,
  host_id uuid,
  title text,
  state text not null default 'idle',
  config jsonb not null default '{}'::jsonb,   -- 计分参数 / 轮数上限 / 抢答窗 W(ms)
  created_at timestamptz default now(),
  closed_at timestamptz
);

-- 2. 参与与在线（投屏要展示全班姓名，故读策略放开给已登录用户）
create table if not exists public.live_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  user_id uuid not null,
  name text,
  joined_at timestamptz default now(),
  last_seen timestamptz default now()
);

-- 3. 教师指令 / 信号（进实时发布；客户端收到后按需拉权威数据）
create table if not exists public.live_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

-- 4. 一轮 = 一题（含题干，学生可读；术语不在这里）
create table if not exists public.live_spell_rounds (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  group_no int not null,                       -- 第几回合
  round_no int not null,                       -- 回合内第几轮
  stage text not null default 'knockout' check (stage in ('knockout', 'buzz')),
  prompt text not null,                        -- 题干：脱敏英文释义
  state text not null default 'open' check (state in ('open', 'settled')),
  deadline_at timestamptz,                     -- 服务端写入的权威时限
  answered_count int not null default 0,       -- 由提交 RPC 维护（投屏用，不暴露具体人）
  correct_count int not null default 0,
  first_correct_at timestamptz,                -- 本轮首个答对者的服务端时间（抢答窗基准）
  solved_users jsonb,                          -- 结算后的并列胜者 user_id 列表（抢答段）
  settled_at timestamptz,
  created_at timestamptz default now()
);

-- 5. 该轮术语（RLS 仅教师可读 —— 学生本地有整套词库，term_id 泄漏等于送答案）
create table if not exists public.live_round_secrets (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null,
  term_id text not null
);

-- 6. 提交（读策略只放本人 + 教师，防互相抄；「已答对 M 人」走计数列）
create table if not exists public.live_spell_answers (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null,
  session_id uuid not null,
  group_no int not null,
  user_id uuid not null,
  text text not null default '',
  is_correct boolean not null default false,
  created_at timestamptz not null default now()   -- 由服务端 now() 生成，绝不接受客户端时间
);

-- 7. 回合存亡与积分（投屏存活表 / 总积分榜的数据源）
create table if not exists public.live_spell_state (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  group_no int not null,
  user_id uuid not null,
  name text,
  out_round_no int,                             -- 在该回合作废于第几轮；null = 仍存活
  survived_rounds int not null default 0,
  points int not null default 0,
  rank_in_group int,                            -- 1 / 2 / 3（结算后写入）
  updated_at timestamptz default now()
);

-- ============================================
-- 行级安全
--   读：已登录可读（投屏需要全班名单与状态）
--   写：仅教师（除「本人写自己的参与行 / 提交行」）
--   live_round_secrets：无读策略 = 学生读不到
-- ============================================
alter table public.live_sessions enable row level security;
alter table public.live_participants enable row level security;
alter table public.live_events enable row level security;
alter table public.live_spell_rounds enable row level security;
alter table public.live_round_secrets enable row level security;
alter table public.live_spell_answers enable row level security;
alter table public.live_spell_state enable row level security;

-- ---- live_sessions ----
drop policy if exists "live_sessions_read" on public.live_sessions;
create policy "live_sessions_read" on public.live_sessions
  for select using (auth.role() = 'authenticated');
drop policy if exists "live_sessions_teacher" on public.live_sessions;
create policy "live_sessions_teacher" on public.live_sessions
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- ---- live_participants ----
drop policy if exists "live_participants_read" on public.live_participants;
create policy "live_participants_read" on public.live_participants
  for select using (auth.role() = 'authenticated');
drop policy if exists "live_participants_self_insert" on public.live_participants;
create policy "live_participants_self_insert" on public.live_participants
  for insert with check (auth.uid() = user_id);
drop policy if exists "live_participants_self_update" on public.live_participants;
create policy "live_participants_self_update" on public.live_participants
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "live_participants_teacher" on public.live_participants;
create policy "live_participants_teacher" on public.live_participants
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- ---- live_events ----
drop policy if exists "live_events_read" on public.live_events;
create policy "live_events_read" on public.live_events
  for select using (auth.role() = 'authenticated');
drop policy if exists "live_events_teacher" on public.live_events;
create policy "live_events_teacher" on public.live_events
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- ---- live_spell_rounds ----
drop policy if exists "live_spell_rounds_read" on public.live_spell_rounds;
create policy "live_spell_rounds_read" on public.live_spell_rounds
  for select using (auth.role() = 'authenticated');
drop policy if exists "live_spell_rounds_teacher" on public.live_spell_rounds;
create policy "live_spell_rounds_teacher" on public.live_spell_rounds
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- ---- live_round_secrets：只有教师（学生无任何策略 = 读不到）----
drop policy if exists "live_round_secrets_teacher" on public.live_round_secrets;
create policy "live_round_secrets_teacher" on public.live_round_secrets
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- ---- live_spell_answers：本人 + 教师可读；本人可写自己的提交 ----
drop policy if exists "live_spell_answers_read" on public.live_spell_answers;
create policy "live_spell_answers_read" on public.live_spell_answers
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher')
  );
drop policy if exists "live_spell_answers_self_insert" on public.live_spell_answers;
create policy "live_spell_answers_self_insert" on public.live_spell_answers
  for insert with check (auth.uid() = user_id);
drop policy if exists "live_spell_answers_teacher" on public.live_spell_answers;
create policy "live_spell_answers_teacher" on public.live_spell_answers
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- ---- live_spell_state ----
drop policy if exists "live_spell_state_read" on public.live_spell_state;
create policy "live_spell_state_read" on public.live_spell_state
  for select using (auth.role() = 'authenticated');
drop policy if exists "live_spell_state_teacher" on public.live_spell_state;
create policy "live_spell_state_teacher" on public.live_spell_state
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- ============================================
-- 加入实时发布（Postgres Changes 的前提；订阅的表必须有主键，上面都有）
--   只推「信号」：事件、轮次状态、在线名单、回合存亡与积分
--   live_spell_answers 刻意不进发布（高频 + 提交内容敏感）
-- ============================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_events'
  ) then
    alter publication supabase_realtime add table public.live_events;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_spell_rounds'
  ) then
    alter publication supabase_realtime add table public.live_spell_rounds;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_participants'
  ) then
    alter publication supabase_realtime add table public.live_participants;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_spell_state'
  ) then
    alter publication supabase_realtime add table public.live_spell_state;
  end if;
end $$;
