-- 教材原文页 + 页级索引：支撑知识库「两级检索」（索引常驻 / 原文按需取页）
-- 内容与现有 skill_content 一致：仅登录用户可读（RLS），不随静态资源公开分发。

-- 1) 页级原文：按 (book, page) 精确取，前端只拉命中的十几页
create table if not exists skill_pages (
  book    text not null,
  page    int  not null,
  chapter text,
  text    text not null,
  primary key (book, page)
);

alter table skill_pages enable row level security;

drop policy if exists "skill_pages read for authenticated" on skill_pages;
create policy "skill_pages read for authenticated"
  on skill_pages for select
  to authenticated
  using (true);

create index if not exists skill_pages_book_idx on skill_pages (book);

-- 2) 页级索引：每本一行 jsonb（约 370KB/本），随知识库一起下发供前端打分
create table if not exists skill_page_index (
  book       text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table skill_page_index enable row level security;

drop policy if exists "skill_page_index read for authenticated" on skill_page_index;
create policy "skill_page_index read for authenticated"
  on skill_page_index for select
  to authenticated
  using (true);
