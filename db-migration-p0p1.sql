-- ============================================
-- P0 + P1 数据库迁移：用户角色（四分类+多归属）+ 班级
-- 在阿里云 Supabase 控制台 → SQL Editor 中整段执行
-- ============================================

-- 1. 角色表（user_id + role 联合主键，一个用户多行 = 多角色）
create table if not exists public.user_roles (
  user_id uuid not null,
  role text not null check (role in ('developer', 'teacher', 'student', 'guest')),
  primary key (user_id, role)
);

-- 迁移现有 teacher_roles → user_roles（现有教师账号变为 teacher 角色；user_id 由 text cast 为 uuid）
insert into public.user_roles (user_id, role)
select user_id::uuid, 'teacher' from public.teacher_roles
on conflict do nothing;

-- 2. 班级表
create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  teacher_id uuid,
  syllabus text,
  papers text[] default '{}'
);

-- 3. student_data 加班级字段
alter table public.student_data
  add column if not exists class_id uuid;

-- 4. 行级安全（RLS）
alter table public.user_roles enable row level security;
alter table public.classes enable row level security;

-- user_roles：所有已登录用户可读（写入仅通过 SQL，无 REST 写策略）
drop policy if exists "user_roles_read" on public.user_roles;
create policy "user_roles_read" on public.user_roles
  for select using (auth.role() = 'authenticated');

-- classes：已登录用户可读；教师可写
drop policy if exists "classes_read" on public.classes;
create policy "classes_read" on public.classes
  for select using (auth.role() = 'authenticated');

drop policy if exists "classes_write" on public.classes;
create policy "classes_write" on public.classes
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- 5. 设置账号角色
-- chenzh@dtd-edu.cn → teacher + developer
insert into public.user_roles (user_id, role)
select id, 'teacher' from auth.users where email = 'chenzh@dtd-edu.cn'
on conflict do nothing;
insert into public.user_roles (user_id, role)
select id, 'developer' from auth.users where email = 'chenzh@dtd-edu.cn'
on conflict do nothing;

-- abc@example.com → student + developer
insert into public.user_roles (user_id, role)
select id, 'student' from auth.users where email = 'abc@example.com'
on conflict do nothing;
insert into public.user_roles (user_id, role)
select id, 'developer' from auth.users where email = 'abc@example.com'
on conflict do nothing;

-- test.student@example.com → developer（仅标记排除，不做业务角色）
insert into public.user_roles (user_id, role)
select id, 'developer' from auth.users where email = 'test.student@example.com'
on conflict do nothing;

-- 6.（可选）创建班级示例：A1 学 Paper 1-2，A2 学 Paper 3-4
-- 需要时取消注释执行；teacher_id 会自动填为 chenzh@dtd-edu.cn 的 uid
-- insert into public.classes (name, teacher_id, papers) values
--   ('A1 社会学', (select id from auth.users where email = 'chenzh@dtd-edu.cn'), array['Paper 1','Paper 2']),
--   ('A2 社会学', (select id from auth.users where email = 'chenzh@dtd-edu.cn'), array['Paper 3','Paper 4']);
