-- ============================================
-- 随堂测验 + 作业（P1+P2）：quizzes + quiz_submissions
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）
-- ============================================

-- 1. 试卷主表
create table if not exists public.quizzes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,                 -- 4 位密码
  title text not null,
  kind text not null default 'quiz' check (kind in ('quiz', 'homework')),
  selection_mode text not null check (selection_mode in ('random', 'manual')),
  papers text[] default '{}',
  category text,
  units text[] default '{}',
  question_count int not null,
  duration_minutes int not null,
  question_types text[] not null,            -- 'spelling' / 'choice' / 'matching'
  questions jsonb not null,                  -- 生成时固定的题目快照
  open_at timestamptz,                       -- 统一开考/开放时间（可空 = 随时可进）
  due_at timestamptz,                        -- 作业截止时间（随堂测验可空）
  allow_resume boolean not null default false, -- 作业模式：允许保存并退出后继续
  created_by uuid,
  created_at timestamptz default now()
);

-- 2. 交卷表
create table if not exists public.quiz_submissions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid references public.quizzes(id) on delete cascade,
  user_id uuid not null,
  email text,
  name text,
  answers jsonb not null default '{}',
  score int not null default 0,
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted')),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  leave_count int not null default 0,
  leave_seconds int not null default 0,
  order_seed int not null,
  unique (quiz_id, user_id)                  -- 每人一份
);

-- 3. 行级安全
alter table public.quizzes enable row level security;
alter table public.quiz_submissions enable row level security;

-- quizzes：教师可写；所有已登录用户可读（学生凭密码拉题）
drop policy if exists "quizzes_write" on public.quizzes;
create policy "quizzes_write" on public.quizzes
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

drop policy if exists "quizzes_read" on public.quizzes;
create policy "quizzes_read" on public.quizzes
  for select using (auth.role() = 'authenticated');

-- quiz_submissions：学生可 insert/update 自己的卷；教师可读
drop policy if exists "quiz_submissions_student" on public.quiz_submissions;
create policy "quiz_submissions_student" on public.quiz_submissions
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "quiz_submissions_student_update" on public.quiz_submissions;
create policy "quiz_submissions_student_update" on public.quiz_submissions
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "quiz_submissions_teacher_read" on public.quiz_submissions;
create policy "quiz_submissions_teacher_read" on public.quiz_submissions
  for select
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));
