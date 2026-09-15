-- ============================================
-- ManageBac 分数同步（第二批）：随堂测验支持 + 名单例外学生
-- 设计见《分数同步到ManageBac方案.md》；第一批见 db-migration-mb-sync.sql
-- 幂等，可重复执行。执行方式（本机 psql，免交互）：
--   $env:PGPASSFILE="$env:USERPROFILE\.pgpass"
--   psql "postgresql://postgres@spb-olltk79n0rjrawe5.supabase.opentrust.net:5432/postgres" -w -v ON_ERROR_STOP=1 -f db-migration-mb-sync-2.sql
-- ============================================

-- 1. 测验 / 作业也发短码（与 grouper_runs.mb_short_code 同一套约定：[A1-0915]）
--    年级位由 quizzes.papers 推（P1/P2 → A1、P3/P4 → A2）；推不出时由教师在界面选。
alter table public.quizzes add column if not exists mb_short_code text;
create index if not exists quizzes_mb_short_code_idx
  on public.quizzes (mb_short_code);

-- 2. 「不登 ManageBac 分」的学生（例如不进 ManageBac 名单的自学学生）
--    置 true 后：名单缺口提示与将来的同步预览都会跳过该生，不再当作"名单缺人"报警。
alter table public.student_data add column if not exists mb_exempt boolean not null default false;

-- 3. task 绑定表改为同时支持「试卷记录」（grouper_runs）与「测验/作业」（quizzes）
--    做法：两个可空外键 + 二选一约束（保留外键级联删除）。
--    原表为空（尚未接入同步写入），直接重建。
drop table if exists public.mb_task_links;

create table public.mb_task_links (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.grouper_runs(id) on delete cascade,   -- 试卷成绩侧
  quiz_id uuid references public.quizzes(id) on delete cascade,       -- 随堂测验/作业侧
  class_id uuid not null references public.classes(id) on delete cascade,
  mb_class_id text,
  mb_task_id text not null,       -- 例：27568440（来自 .../core_tasks/27568440）
  mb_task_name text,              -- 绑定当时的名字快照
  bound_by uuid,
  bound_at timestamptz default now(),
  -- 恰好挂在一侧（PG 的 <> 对 null 返回 null，故此写法在两侧都为空时也会被拒）
  check ((run_id is not null) <> (quiz_id is not null))
);

create index if not exists mb_task_links_run_idx
  on public.mb_task_links (run_id, class_id);
create index if not exists mb_task_links_quiz_idx
  on public.mb_task_links (quiz_id, class_id);

-- 4. 行级安全：仅 teacher / developer 可读写
alter table public.mb_task_links enable row level security;

drop policy if exists "mb_task_links_teacher" on public.mb_task_links;
create policy "mb_task_links_teacher" on public.mb_task_links
  for all
  using (exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role in ('teacher', 'developer')
  ))
  with check (exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role in ('teacher', 'developer')
  ));
