-- ManageBac 登录会话（cookie）暂存 —— 2026-09-16 教师确认的方案 (a)
--
-- 为什么需要：线上「一键绑定」要在 Worker 里打开 ManageBac 成绩册，而 **Worker 在 Cloudflare 云端
-- 没有登录态**（本机脚本能读 app/_ocrlab_out/mb-cookies.json，云端读不到）。故把教师本机登录得到的
-- cookie 存进本表，Worker 用**请求自带的教师 JWT**读出（RLS 保证只有本人能读），注入浏览器后**只读**抓取。
--
-- 安全口径：
--   · 仅教师本人可读写（策略 auth.uid()::text = teacher_id）；不给 anon、不给 truncate
--   · 表内只存 ManageBac 域名相关的 cookie，供抓取 task 列表 / 写分数使用
--   · cookie 会自然过期；过期时 Worker 会返回明确提示，教师重新登录一次即可（本机脚本自动回写本表）
--   · 写入只由教师本机脚本完成（走 psql 直连）；Worker 侧**只读不写**
--   · teacher_id 与 teacher_roles.user_id 同口径（text，不建外键，与既有表保持一致）
--
-- 幂等：可重复执行。

create table if not exists public.mb_sessions (
  teacher_id  text primary key,
  cookies     jsonb not null,           -- 注入浏览器的 cookie 数组（仅 managebac 域名）
  domain      text,                     -- 抓取目标域，如 dtd.managebac.cn
  captured_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.mb_sessions is 'ManageBac 登录 cookie（供 Worker 云端只读抓取；仅教师本人可访问）';

alter table public.mb_sessions enable row level security;

drop policy if exists mb_sessions_own on public.mb_sessions;
create policy mb_sessions_own on public.mb_sessions
  for all
  using (auth.uid()::text = teacher_id)
  with check (auth.uid()::text = teacher_id);

-- 用 psql 直接建表时 Supabase 的 authenticated 角色往往没被自动授权 → 客户端会报 permission denied
grant select, insert, update, delete on public.mb_sessions to authenticated;

-- ⚠ TRUNCATE 不受 RLS 约束：按最小权限原则收掉，避免任何已登录用户清空整张表
revoke truncate, references, trigger on public.mb_sessions from authenticated;
revoke all on public.mb_sessions from anon;
