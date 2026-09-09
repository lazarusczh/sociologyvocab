-- ============================================
-- AI 问答门禁（教师临时关闭学生 AI 问答，防论文/考试作弊）
-- 单行表（id=1）：disabled_at 非空 = 关闭中；note 为学生可见的提示语
-- RLS：已登录可读；教师（teacher 角色）可写
-- 幂等，可重复执行
-- ============================================

create table if not exists public.ai_gate (
  id          integer primary key default 1 check (id = 1),
  disabled_at timestamptz null,
  note        text not null default '',
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

insert into public.ai_gate (id)
values (1)
on conflict (id) do nothing;

alter table public.ai_gate enable row level security;

drop policy if exists "ai_gate_read" on public.ai_gate;
create policy "ai_gate_read" on public.ai_gate
  for select using (auth.role() = 'authenticated');

drop policy if exists "ai_gate_write" on public.ai_gate;
create policy "ai_gate_write" on public.ai_gate
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

grant select, insert, update on public.ai_gate to authenticated;
