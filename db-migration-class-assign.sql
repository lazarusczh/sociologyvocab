-- ============================================
-- 教师分班：给 student_data 增加「教师可更新 class_id」的 RLS 策略
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）
-- ============================================

-- 1. 确认 classes 表的教师写策略存在（若之前执行过 db-migration-p0p1.sql 则已有，这里补防）
--    教师可对 classes 表增删改查
drop policy if exists "classes_read" on public.classes;
create policy "classes_read" on public.classes
  for select using (auth.role() = 'authenticated');

drop policy if exists "classes_write" on public.classes;
create policy "classes_write" on public.classes
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- 2. 教师给 student_data 更新分班字段（class_id）的写策略
--    仅允许教师角色更新 class_id（含置空「未分班」）
drop policy if exists "student_data_assign_class" on public.student_data;
create policy "student_data_assign_class" on public.student_data
  for update
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- 3.（可选）示例班级：A1 学 Paper 1-2，A2 学 Paper 3-4
-- 需要时取消注释执行；teacher_id 会自动填为 chenzh@dtd-edu.cn 的 uid
-- insert into public.classes (name, teacher_id, papers) values
--   ('A1 社会学', (select id from auth.users where email = 'chenzh@dtd-edu.cn'), array['Paper 1','Paper 2']),
--   ('A2 社会学', (select id from auth.users where email = 'chenzh@dtd-edu.cn'), array['Paper 3','Paper 4']);
