-- ============================================
-- 词库上云 P0：vocab_releases（词库发布表）
-- 在阿里云 Supabase 控制台 → SQL Editor 中整段执行
-- ============================================

create table if not exists public.vocab_releases (
  id uuid primary key default gen_random_uuid(),
  version int not null,
  data jsonb not null,
  note text,
  published_by uuid,
  published_at timestamptz default now()
);

alter table public.vocab_releases enable row level security;

-- 教师可 insert（发布）
drop policy if exists "vocab_releases_write" on public.vocab_releases;
create policy "vocab_releases_write" on public.vocab_releases
  for insert
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- 所有人可 select（拉最新，含匿名/离线游客）
drop policy if exists "vocab_releases_read" on public.vocab_releases;
create policy "vocab_releases_read" on public.vocab_releases
  for select using (true);
