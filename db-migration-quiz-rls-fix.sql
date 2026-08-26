-- ============================================
-- 修复 quiz_submissions 读取策略（随堂测验/作业交卷 RLS 报错）
-- 根因：原 select 策略只允许 teacher 读取，学生/开发者账号交卷（upsert 需返回受影响行）
--       被 RLS 拦截，报 "new row violates row-level security policy"。
-- 修复：所有登录用户可读取自己的卷；教师可读取全部。
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）
-- ============================================

drop policy if exists "quiz_submissions_teacher_read" on public.quiz_submissions;
drop policy if exists "quiz_submissions_read" on public.quiz_submissions;

create policy "quiz_submissions_read" on public.quiz_submissions
  for select
  using (
    auth.uid() = user_id
    or exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher')
  );
