-- ============================================
-- 定义题（术语 → 写定义）数据层
--   1) definition_items    题目与踩分点（教师维护，学生只读）
--   2) definition_attempts 学生作答 + AI 判分日志（用于教师抽检与后续 few-shot）
-- 在 Supabase 控制台 → SQL Editor 整段执行（幂等，可重复跑）
-- ============================================

-- ---------- 1) 题目与踩分点 ----------
create table if not exists public.definition_items (
  id           text primary key,               -- 术语归一化 slug（幂等导入用）
  term         text not null,                  -- 展示用术语
  chinese      text,                           -- 中文
  paper        text,
  units        text[],                         -- 所属单元（可多值）
  reference    text,                           -- 参考来源 key：main / tb1 / igcse0495 ...
  keypoints    jsonb not null default '[]'::jsonb,   -- 必踩点 [{text, source}]
  bonus        jsonb not null default '[]'::jsonb,   -- 加分点（其他来源独有）
  sources      text[],                         -- 有哪些来源
  source_notes jsonb default '{}'::jsonb,
  beta         boolean not null default true,  -- 先挂 beta（日常打卡训练），检验合格后转正式
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.definition_items enable row level security;

-- 读：登录用户即可（含学生；与词库一致的可见性口径）
drop policy if exists "definition_items_read" on public.definition_items;
create policy "definition_items_read" on public.definition_items
  for select to authenticated using (true);

-- 写：教师 / 开发者
drop policy if exists "definition_items_write" on public.definition_items;
create policy "definition_items_write" on public.definition_items
  for all to authenticated
  using (exists (select 1 from public.user_roles r
                 where r.user_id = auth.uid() and r.role in ('teacher', 'developer')))
  with check (exists (select 1 from public.user_roles r
                      where r.user_id = auth.uid() and r.role in ('teacher', 'developer')));

create index if not exists definition_items_paper_idx on public.definition_items (paper);
create index if not exists definition_items_beta_idx on public.definition_items (beta, active);

-- ---------- 2) 作答与判分日志 ----------
create table if not exists public.definition_attempts (
  id           bigserial primary key,
  user_id      uuid not null,
  item_id      text not null,                  -- 不设外键：题目重导时历史记录不丢
  answer       text not null,
  verdict      text not null,                  -- correct / partial / wrong
  coverage     jsonb,                          -- 模型给的逐要素覆盖度 [0|0.5|1, ...]
  listing_only boolean,                        -- 是否只是罗列关键词
  reason       text,                           -- 模型给的理由（中文）
  confidence   numeric,
  model        text,                           -- 判分模型 id
  tier         text,                           -- 走的是哪一档（nemotron/agnes/ms）
  ms           int,                            -- 判分耗时
  review       text,                           -- 教师复核档位（空=未复核）
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);

alter table public.definition_attempts enable row level security;

-- 学生：可插自己的、可读自己的
drop policy if exists "definition_attempts_insert_own" on public.definition_attempts;
create policy "definition_attempts_insert_own" on public.definition_attempts
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "definition_attempts_read_own" on public.definition_attempts;
create policy "definition_attempts_read_own" on public.definition_attempts
  for select to authenticated using (auth.uid() = user_id);

-- 教师 / 开发者：可读全部、可写复核
drop policy if exists "definition_attempts_read_staff" on public.definition_attempts;
create policy "definition_attempts_read_staff" on public.definition_attempts
  for select to authenticated
  using (exists (select 1 from public.user_roles r
                 where r.user_id = auth.uid() and r.role in ('teacher', 'developer')));

drop policy if exists "definition_attempts_update_staff" on public.definition_attempts;
create policy "definition_attempts_update_staff" on public.definition_attempts
  for update to authenticated
  using (exists (select 1 from public.user_roles r
                 where r.user_id = auth.uid() and r.role in ('teacher', 'developer')))
  with check (exists (select 1 from public.user_roles r
                      where r.user_id = auth.uid() and r.role in ('teacher', 'developer')));

create index if not exists definition_attempts_user_idx on public.definition_attempts (user_id, created_at desc);
create index if not exists definition_attempts_item_idx on public.definition_attempts (item_id);
create index if not exists definition_attempts_review_idx on public.definition_attempts (review) where review is null;
