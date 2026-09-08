-- ============================================
-- 教材知识站内容：skill_content（蒸馏 skill 内容发布表）
-- 版权保护：内容仅登录用户可读（不能放静态 dist，需经云端 RLS 保护）
-- ============================================

create table if not exists public.skill_content (
  id uuid primary key default gen_random_uuid(),
  version int not null,
  data jsonb not null,
  note text,
  published_by uuid,
  published_at timestamptz default now()
);

alter table public.skill_content enable row level security;

-- 教师可 insert（发布新版本）
drop policy if exists "skill_content_write" on public.skill_content;
create policy "skill_content_write" on public.skill_content
  for insert
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- 任意已登录用户可读（含学生/教师；匿名不可读 → 满足版权要求）
drop policy if exists "skill_content_read" on public.skill_content;
create policy "skill_content_read" on public.skill_content
  for select
  using (auth.uid() is not null);
