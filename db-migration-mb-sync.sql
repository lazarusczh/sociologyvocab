-- ============================================
-- ManageBac 分数同步：短码 / 班级绑定 / 名单映射 / task 绑定
-- 设计说明见：分数同步到ManageBac方案.md
-- 幂等，可重复执行。执行方式（本机 psql，免交互）：
--   $env:PGPASSFILE="$env:USERPROFILE\.pgpass"
--   psql "postgresql://postgres@spb-olltk79n0rjrawe5.supabase.opentrust.net:5432/postgres" -w -v ON_ERROR_STOP=1 -f db-migration-mb-sync.sql
--
-- ⚠ 索引一律用「普通索引」而非唯一索引/部分索引/表达式索引：
--   本库为 AnalyticDB / Greenplum 内核，对后三者的支持不确定。
--   「唯一性」改由应用层保证（写入方全部是我们自己的教师端代码，规模小）：
--     · grouper_runs.mb_short_code：生成前先 select 查重，冲突就加 b/c 后缀
--     · mb_task_links：绑定 = 先 delete 该 (run_id, class_id) 再 insert
--     · mb_rosters：导入 = 先 delete 该 class_id 的旧名单再整批 insert
-- ============================================

-- 1. 试卷记录增短码（我方生成、创建时固定不变；格式 [A1-0712]，同日冲突加 b/c 后缀）
alter table public.grouper_runs add column if not exists mb_short_code text;
create index if not exists grouper_runs_mb_short_code_idx
  on public.grouper_runs (mb_short_code);

-- 2. 班级增 ManageBac 成绩册绑定
--    mb_class_url = 教师贴的整条 URL（形如 https://<school>.managebac.cn/teacher/classes/11496547/gradebook/core_tasks）
--    mb_class_id  = 前端当场从 URL 解析出的班级号（用于回显与校验，避免贴错班）
alter table public.classes add column if not exists mb_class_url text;
alter table public.classes add column if not exists mb_class_id text;

-- 3. 名单映射（ManageBac 导出的班级名单：邮箱 → ManageBac 显示名）
--    不强制每学期重导；发现有人匹配不到时提示重导。email 入库前统一转小写（应用层做）
create table if not exists public.mb_rosters (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  email text not null,                        -- 学校邮箱（站内注册邮箱），整条链路的唯一可信键
  mb_name text not null,                      -- ManageBac 成绩册里的显示名（填分时按它定位行）
  imported_by uuid,
  imported_at timestamptz default now()
);

create index if not exists mb_rosters_class_email_idx
  on public.mb_rosters (class_id, email);

-- 4. task 绑定（一条作业 ↔ 多个 task：同一次作业发给两个班 = ManageBac 里两个 task）
--    存 mb_task_id（URL 里的数字 id）⇒ 教师日后改 task 名不影响同步
create table if not exists public.mb_task_links (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.grouper_runs(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  mb_class_id text,
  mb_task_id text not null,                   -- 例：27568440（来自 .../core_tasks/27568440）
  mb_task_name text,                          -- 绑定当时的名字快照，便于显示与事后审计
  bound_by uuid,
  bound_at timestamptz default now()
);

create index if not exists mb_task_links_run_class_idx
  on public.mb_task_links (run_id, class_id);

-- 5. 行级安全：仅 teacher / developer 可读写（学生端无任何入口，无需 select 策略）
alter table public.mb_rosters enable row level security;
alter table public.mb_task_links enable row level security;

drop policy if exists "mb_rosters_teacher" on public.mb_rosters;
create policy "mb_rosters_teacher" on public.mb_rosters
  for all
  using (exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role in ('teacher', 'developer')
  ))
  with check (exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role in ('teacher', 'developer')
  ));

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
