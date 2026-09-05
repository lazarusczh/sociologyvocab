-- 题库上云：question_bank（教师维护、组卷器读取）+ qb_releases 发布快照
-- 口径见《组卷器数据模型初稿.md》§1/§6；RLS 风格同 db-migration-quiz.sql
-- 2026-09-05 　在 Supabase SQL Editor 整段执行

-- 1. 题库表（一行 = 一条 BankItem）
create table if not exists public.question_bank (
  qid         text primary key,
  session     text not null,                -- S26 / M26 / W24 …
  paper       smallint not null check (paper between 1 and 4),
  variant     smallint not null,            -- 1..3（variant4 遗留老卷不收录）
  comp        text not null,                -- '11'..'43'
  q           text,                         -- '1'/'2a'/'2b'/'3'/null
  stem        text not null,
  statement   text,                         -- 命题句（无则 null）
  marks       text not null,                -- '4'/'10+6'/'35'
  marks_total integer not null,
  kind        text not null check (kind in ('plain', 'statement', 'statement-pair')),
  parts       jsonb,                        -- 10+6: [{"part":"a","marks":10,"side":"for"},{"part":"b","marks":6,"side":"against"}]
  topics      text[] not null default '{}',
  note        text,                         -- 教师备注/勘误
  updated_at  timestamptz not null default now()
);

create index if not exists question_bank_paper_session on public.question_bank (paper, session);
create index if not exists question_bank_q on public.question_bank (q);
create index if not exists question_bank_topics on public.question_bank using gin (topics);

-- 2. 发布快照（组卷器按版本读取）
create table if not exists public.qb_releases (
  id          bigint generated always as identity primary key,
  version     integer not null unique,
  note        text,
  items       jsonb not null,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

-- 3. 行级安全
alter table public.question_bank enable row level security;
alter table public.qb_releases enable row level security;

drop policy if exists "question_bank_read" on public.question_bank;
create policy "question_bank_read" on public.question_bank
  for select using (auth.role() = 'authenticated');

drop policy if exists "question_bank_teacher_write" on public.question_bank;
create policy "question_bank_teacher_write" on public.question_bank
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

drop policy if exists "qb_releases_read" on public.qb_releases;
create policy "qb_releases_read" on public.qb_releases
  for select using (auth.role() = 'authenticated');

drop policy if exists "qb_releases_teacher_insert" on public.qb_releases;
create policy "qb_releases_teacher_insert" on public.qb_releases
  for insert
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));

-- 4. 初始填充建议：
--    根目录 question-bank.json（680 条）字段与列同名（qid/session/paper/variant/comp/q/stem/
--    statement/marks/marks_total/kind/parts/topics）；量大时用控制台 JSON/CSV 导入，或待后台
--    「题库」tab 上线后上传 upsert（P0 项）。note 留空、updated_at=now()。
