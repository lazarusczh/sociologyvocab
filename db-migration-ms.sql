-- Mark scheme 分节库上云：ms_sections（session+comp+q 一行一条 ms 分节文本）
-- 数据源：ms-data.json（pdf-text/extract_ms_all.py + parse_ms.py 生成）
-- 口径见《组卷器数据模型初稿.md》§3；RLS 风格同 quizzes/question_bank
-- 2026-09-05 　psql 整段执行

create table if not exists public.ms_sections (
  session    text not null,                -- s26 / m21 / w24 …
  comp       text not null,                -- '11'..'43'（含 137 卷；variant4 遗留卷已剔除）
  paper      smallint not null check (paper between 1 and 4),
  q          text not null,                -- ms 分节题号，如 '1'/'2(a)'/'3(b)'
  text       text not null,                -- 该题 ms 全文（题干原文 + 评分细则/level 描述）
  note       text,                         -- 教师备注（切段勘误等）
  updated_at timestamptz not null default now(),
  primary key (session, comp, q)
);

create index if not exists ms_sections_session_comp on public.ms_sections (session, comp);

alter table public.ms_sections enable row level security;

drop policy if exists "ms_sections_read" on public.ms_sections;
create policy "ms_sections_read" on public.ms_sections
  for select using (auth.role() = 'authenticated');

drop policy if exists "ms_sections_teacher_write" on public.ms_sections;
create policy "ms_sections_teacher_write" on public.ms_sections
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));
