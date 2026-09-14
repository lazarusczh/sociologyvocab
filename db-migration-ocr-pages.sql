-- OCR 辅助阅卷 · 录入记录表（2026-09-14）
--
-- 目的：转写结果落库，刷新/换设备都不丢，**避免重复消耗模型额度**（教师手上有纸质原件，故不必导出）。
-- 隐私口径：**只存文本，不存答卷图片**（图片仅在识别时转发给模型，不落盘）。
-- 权限：仅本人（教师/开发者自己的账号）可读写自己的记录 —— RLS 用 auth.uid() 判定，学生无权访问。

create table if not exists public.ocr_pages (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references auth.users (id) on delete cascade,
  label       text,                       -- 备注（如学生姓名），便于日后对应到人
  page_name   text,                       -- 原始文件名或「拍题 N」
  text        text not null,              -- 转写正文
  model       text,                       -- 实际使用的视觉模型 id
  elapsed_ms  integer,                    -- 本次耗时（毫秒）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.ocr_pages is 'OCR 辅助阅卷的转写记录（仅存储文本，不含答卷图片）';

alter table public.ocr_pages enable row level security;

-- 只允许本人读写（同一策略覆盖 select/insert/update/delete）
drop policy if exists ocr_pages_own on public.ocr_pages;
create policy ocr_pages_own on public.ocr_pages
  for all
  using (auth.uid() = teacher_id)
  with check (auth.uid() = teacher_id);

create index if not exists ocr_pages_teacher_created_idx
  on public.ocr_pages (teacher_id, created_at desc);

-- 表级授权：用 psql 直接建表时，Supabase 的 authenticated 角色往往没有被自动授权，
-- 客户端会报 "permission denied for table ocr_pages"。行级安全性仍由上面的 RLS 策略兜住。
grant select, insert, update, delete on public.ocr_pages to authenticated;

-- ⚠ TRUNCATE 不受 RLS 约束（PostgREST 也调不到，但按最小权限原则直接收掉）：
-- 否则任何已登录用户理论上能清空整张表（含其他教师的记录）。
revoke truncate, references, trigger on public.ocr_pages from authenticated;
revoke all on public.ocr_pages from anon;

-- 更新 updated_at（简单触发器，避免前端每次都要传）
create or replace function public.ocr_pages_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ocr_pages_touch_trg on public.ocr_pages;
create trigger ocr_pages_touch_trg
  before update on public.ocr_pages
  for each row execute function public.ocr_pages_touch();
