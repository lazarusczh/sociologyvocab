-- ============================================
-- 课堂活动 · 第二种模式：口头速答（oral）
--
-- 与拼写竞赛**刻意分开**：
--   · 没有题干（问题由教师口头出）→ 表里没有 prompt 字段
--   · 没有判定、没有淘汰、没有胜负、没有积分 → **不需要任何 RPC**，学生提交就是一次普通写入
--   · 学生可以反复修改自己的答案（一题一人一行，upsert 覆盖）
--   · 投屏只显示答案文本且匿名；教师端能看到答案来自谁
--
-- 幂等，可重复执行。
-- ============================================

-- 1. 放宽 kind 约束：spell（拼写竞赛）/ guess（课堂猜词，未实现）/ oral（口头速答）
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'live_sessions_kind_check') then
    alter table public.live_sessions drop constraint live_sessions_kind_check;
  end if;
  alter table public.live_sessions add constraint live_sessions_kind_check check (kind in ('spell', 'guess', 'oral'));
end $$;

-- 2. 一题一行（题由教师口述，故没有题干）
create table if not exists public.live_oral_rounds (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  round_no int not null,
  note text,                                    -- 可选：教师自己记一句（课后回看/讲评用），不发给学生
  state text not null default 'open' check (state in ('open', 'closed')),
  opened_at timestamptz default now(),
  closed_at timestamptz
);

-- 3. 答案（一题一人一行，可改：前端用 upsert 覆盖）
create table if not exists public.live_oral_answers (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null,
  session_id uuid not null,
  round_no int not null,
  user_id uuid not null,
  name text,
  text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (round_id, user_id)
);

-- ============================================
-- 行级安全
--   rounds：已登录可读（学生要知道"现在是第几题、是否收题"），教师可写
--   answers：**本人 + 教师**可读 —— 这条正是「投屏能匿名、教师仍看得到是谁」的前提
--            （学生互相读不到；前端投屏是教师端打开的窗口，所以能读到全部）
-- ============================================
alter table public.live_oral_rounds enable row level security;
alter table public.live_oral_answers enable row level security;

drop policy if exists "live_oral_rounds_read" on public.live_oral_rounds;
create policy "live_oral_rounds_read" on public.live_oral_rounds
  for select using (auth.role() = 'authenticated');

drop policy if exists "live_oral_rounds_teacher" on public.live_oral_rounds;
create policy "live_oral_rounds_teacher" on public.live_oral_rounds
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

drop policy if exists "live_oral_answers_read" on public.live_oral_answers;
create policy "live_oral_answers_read" on public.live_oral_answers
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher')
  );

drop policy if exists "live_oral_answers_self_insert" on public.live_oral_answers;
create policy "live_oral_answers_self_insert" on public.live_oral_answers
  for insert with check (auth.uid() = user_id);

drop policy if exists "live_oral_answers_self_update" on public.live_oral_answers;
create policy "live_oral_answers_self_update" on public.live_oral_answers
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "live_oral_answers_teacher" on public.live_oral_answers;
create policy "live_oral_answers_teacher" on public.live_oral_answers
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- ============================================
-- 加入实时发布
--   rounds：学生据此知道"开新题 / 收题"
--   answers：Realtime 按订阅者 RLS 过滤 —— 学生只会收到**自己**那一行（可用于"改完同步"），
--            教师会收到全班的（控制台与投屏实时刷新）。答案文本很短，payload 无压力。
-- ============================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_oral_rounds'
  ) then
    alter publication supabase_realtime add table public.live_oral_rounds;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_oral_answers'
  ) then
    alter publication supabase_realtime add table public.live_oral_answers;
  end if;
end $$;
