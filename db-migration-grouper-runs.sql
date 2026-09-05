-- ============================================
-- 组卷成绩登记：grouper_runs（拆分方案：组卷器只管出卷，试卷成绩 tab 负责存卷回访 + 学生分数换算）
-- 在 Supabase 控制台 → SQL Editor 中整段执行，或用 psql -f 执行（幂等，可重复执行）
-- ============================================

-- 1. 组卷主表（一份保存下来的卷面 = 一次 run）
create table if not exists public.grouper_runs (
  id uuid primary key default gen_random_uuid(),
  title text not null,                       -- 列表标题（默认自动生成，可改）
  mode text not null check (mode in ('template', 'single', 'free')),
  paper int not null,                        -- 卷种 P1-P4
  template_label text,                       -- 如 'Paper 1 全卷（60）' / '单题布置' / '目标凑分'
  topic text,                                -- 组卷时的考点筛选（空 = 全部）
  slots jsonb not null default '[]',         -- 卷面快照：[{spec, items:[BankItem]}]
  full_raw int not null,                     -- 当次满分
  thresholds jsonb not null default '{}',    -- 已折算到当次满分的 A-E 下限 {A,B,C,D,E}（不含 A*）
  a_star int,                                -- A* 原始分下限（教师可后填/修改）
  scores jsonb not null default '[]',        -- 成绩登记：[{key,name,classId,registered,raw}]
  created_by uuid,
  created_at timestamptz default now()
);

-- 2. 行级安全：仅 teacher / developer 可读写（学生端无查看入口，无需 select 策略）
alter table public.grouper_runs enable row level security;

drop policy if exists "grouper_runs_teacher" on public.grouper_runs;
create policy "grouper_runs_teacher" on public.grouper_runs
  for all
  using (exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role in ('teacher', 'developer')
  ))
  with check (exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role in ('teacher', 'developer')
  ));
