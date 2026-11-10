-- ============================================
-- 角色管理与「按教师归属」的写入隔离（多 syllabus 阶段 D1 的权限部分）
-- 在 Supabase 控制台 → SQL Editor 中整段执行（幂等，可重复执行）
--
-- 为什么要有这个文件：
--   现有全部教师写策略只判「你是不是 teacher」，不判「是不是你的东西」。
--   一旦引入第二位教师（如承接 0495 的同事），他就能改你的班级、你的词库。
--   m00848 明确要求：班级编辑按教师区分；词库编辑至少做到 D1 隔离。
--
-- 本文件做四件事：
--   1. 把现有班级归属回填给实际任教教师，并把 classes_write 收敛为「自己的班」
--   2. 学生分班同样收敛为「只能动自己班里的学生」
--   3. 新建 vocab_overrides（按 syllabus 分行的词条覆盖层），写权限由「谁教这个 syllabus 的班」推导
--   4. 提供三个仅 developer 可调的 RPC：查账户、授予/撤销角色、指定班级任教教师
--      —— 前端的「开发后台 → 账户与班级」面板全部走这三个函数，不直接写表。
--
-- 设计说明（为什么不给 user_roles 加直接写策略）：
--   若给 user_roles 建 INSERT/UPDATE 策略，权限校验要写在 RLS 里，
--   而「谁能授予 developer」这件事本身就成了递归问题。改成「只有 SECURITY DEFINER
--   函数能写，函数内部先验调用者是 developer」更简单，也不会留后门。
-- ============================================


-- ============================================
-- 1. 班级归属回填
--    现有 2 个班（AS/A2 Sociology）teacher_id 全是 NULL，实际由 chenzh 任教。
--    只回填 NULL 的行，不覆盖以后人工指定的归属。
-- ============================================
update public.classes c
set teacher_id = u.id
from auth.users u
where c.teacher_id is null
  and u.email = 'chenzh@dtd-edu.cn';


-- ============================================
-- 2. classes 写策略：按归属收敛
--    读：保持「已登录可读」（学生端要靠它解析 activeSyllabus，见方案 §3.5）
--    写：教师只能写自己任教的班；developer 不受限（用于调整归属和救火）
--
--    注意：新建班级时必须显式写入 teacher_id = 自己，
--    否则 with check 不过。ClassManager.createClass 已同步改（见前端改动）。
-- ============================================
drop policy if exists "classes_read" on public.classes;
create policy "classes_read" on public.classes
  for select using (auth.role() = 'authenticated');

drop policy if exists "classes_write" on public.classes;
create policy "classes_write" on public.classes
  for all
  using (
    exists (
      select 1 from public.user_roles r
      where r.user_id = auth.uid() and r.role = 'developer'
    )
    or (
      exists (
        select 1 from public.user_roles r
        where r.user_id = auth.uid() and r.role = 'teacher'
      )
      and teacher_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.user_roles r
      where r.user_id = auth.uid() and r.role = 'developer'
    )
    or (
      exists (
        select 1 from public.user_roles r
        where r.user_id = auth.uid() and r.role = 'teacher'
      )
      and teacher_id = auth.uid()
    )
  );


-- ============================================
-- 3. student_data 分班策略：只能动自己班里的学生
--    using      看旧行：旧班级必须是我的班（否则不许把他从别人班里拉走）
--    with check 看新行：新班级必须是我的班，或置空（退回未分班）
--    学生的 students_own_row 策略不受影响。
-- ============================================
drop policy if exists "student_data_assign_class" on public.student_data;
create policy "student_data_assign_class" on public.student_data
  for update
  using (
    exists (
      select 1 from public.user_roles r
      where r.user_id = auth.uid() and r.role = 'developer'
    )
    or (
      exists (
        select 1 from public.user_roles r
        where r.user_id = auth.uid() and r.role = 'teacher'
      )
      and exists (
        select 1 from public.classes c
        where c.id = student_data.class_id and c.teacher_id = auth.uid()
      )
    )
  )
  with check (
    exists (
      select 1 from public.user_roles r
      where r.user_id = auth.uid() and r.role = 'developer'
    )
    or (
      exists (
        select 1 from public.user_roles r
        where r.user_id = auth.uid() and r.role = 'teacher'
      )
      and (
        class_id is null
        or exists (
          select 1 from public.classes c
          where c.id = class_id and c.teacher_id = auth.uid()
        )
      )
    )
  );


-- ============================================
-- 4. 修掉遗留不一致：teachers_read_all_students 查的是旧表 teacher_roles
--    旧表只有 1 行、user_id 是 text；新授的教师只进 user_roles，
--    结果「能看到班级但看不到学生」。统一改用 user_roles。
-- ============================================
drop policy if exists "teachers_read_all_students" on public.student_data;
create policy "teachers_read_all_students" on public.student_data
  for select
  using (
    (auth.uid()::text = user_id)
    or exists (
      select 1 from public.user_roles r
      where r.user_id = auth.uid() and r.role in ('teacher', 'developer')
    )
  );


-- ============================================
-- 5. vocab_overrides：词条覆盖层（「id 不变、分两版展示」的落点）
--
--    背景：0495 默认复用 9699 词库（运行时投影）。一旦 0495 教师改了某条词条，
--    不能把 9699 的原始行改掉，否则 9699 学生跟着变；也不能复制整份词库，
--    否则 id 会分叉、学生进度对不上。
--    做法：以 (syllabus, item_id) 为键存「差异」，运行时合并。
--      op='edit' → patch 里的字段覆盖到基础词条上（id 不变）
--      op='hide' → 该 syllabus 下隐藏这条基础词条
--      op='add'  → patch 就是一条完整词条，只在该 syllabus 下可见
--    这样 9699 永远是「基础」，0495 的改动只落在自己的行上，互不可见。
--
--    写权限：谁能改某个 syllabus 的词条 = 谁在教这个 syllabus 的班。
--    归属从 classes 推导，不额外建表；developer 始终可写（用于救火）。
-- ============================================
create table if not exists public.vocab_overrides (
  syllabus   text not null,
  item_id    text not null,
  op         text not null check (op in ('edit', 'hide', 'add')),
  patch      jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (syllabus, item_id)
);

alter table public.vocab_overrides enable row level security;

-- 读：所有登录用户可读（与 vocab_releases 的 read=true 对齐；
-- 词条本来就是对所有学生公开的内容，不算敏感数据）
drop policy if exists "vocab_overrides_read" on public.vocab_overrides;
create policy "vocab_overrides_read" on public.vocab_overrides
  for select using (auth.role() = 'authenticated');

-- 写：按「是否教这个 syllabus 的班」判定
drop policy if exists "vocab_overrides_write" on public.vocab_overrides;
create policy "vocab_overrides_write" on public.vocab_overrides
  for all
  using (
    exists (
      select 1 from public.user_roles r
      where r.user_id = auth.uid() and r.role in ('teacher', 'developer')
    )
    and (
      exists (
        select 1 from public.classes c
        where c.teacher_id = auth.uid() and c.syllabus = vocab_overrides.syllabus
      )
      or exists (
        select 1 from public.user_roles r
        where r.user_id = auth.uid() and r.role = 'developer'
      )
    )
  )
  with check (
    exists (
      select 1 from public.user_roles r
      where r.user_id = auth.uid() and r.role in ('teacher', 'developer')
    )
    and (
      exists (
        select 1 from public.classes c
        where c.teacher_id = auth.uid() and c.syllabus = vocab_overrides.syllabus
      )
      or exists (
        select 1 from public.user_roles r
        where r.user_id = auth.uid() and r.role = 'developer'
      )
    )
  );


-- ============================================
-- 6. 顺带把「两人同时发布会撞版本号」堵掉
--    vocab_releases 只有主键，版本号由前端 getLatestVocabVersion()+1 现算，
--    两个教师同时点发布会写出两条同 version 的记录。
--    现有 100 行版本号 1..100 连续、无重复，可以安全加约束。
-- ============================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.vocab_releases'::regclass
      and conname = 'vocab_releases_syllabus_version_key'
  ) then
    alter table public.vocab_releases
      add constraint vocab_releases_syllabus_version_key unique (syllabus, version);
  end if;
end $$;


-- ============================================
-- 7. RPC 一：账户检索（仅 developer）
--    按邮箱片段找人，顺带返回其角色与任教班级。
--    前端不能直接读 auth.users，只能经这里。
-- ============================================
create or replace function public.admin_search_accounts(q text default '')
returns table (
  user_id uuid,
  email text,
  roles text[],
  last_sign_in_at timestamptz,
  class_names text[]
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_q text := lower(trim(coalesce(q, '')));
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.user_roles r
    where r.user_id = v_uid and r.role = 'developer'
  ) then
    raise exception 'developer only';
  end if;

  return query
  select
    u.id,
    u.email::text,
    coalesce(array_agg(distinct r.role) filter (where r.role is not null), '{}'::text[]) as roles,
    u.last_sign_in_at,
    coalesce(
      (select array_agg(c.name order by c.name) from public.classes c where c.teacher_id = u.id),
      '{}'::text[]
    ) as class_names
  from auth.users u
  left join public.user_roles r on r.user_id = u.id
  where
    v_q = ''
    or lower(u.email::text) like '%' || v_q || '%'
  group by u.id, u.email, u.last_sign_in_at
  order by u.email
  limit 60;
end;
$$;

comment on function public.admin_search_accounts(text) is
  '开发者专用：按邮箱片段检索账号、角色与任教班级';


-- ============================================
-- 8. RPC 二：授予 / 撤销角色（仅 developer）
--    同时双写旧的 teacher_roles 表：该表已不被策略引用（第 4 节已改），
--    但仓库里仍有零星只读它的历史查询，双写成本极低，先留着不制造惊喜。
--    防呆：不允许撤销自己的 developer 角色（防止把自己锁在门外）。
-- ============================================
create or replace function public.admin_set_role(p_email text, p_role text, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_email text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.user_roles r
    where r.user_id = v_uid and r.role = 'developer'
  ) then
    raise exception 'developer only';
  end if;
  if p_role not in ('teacher', 'student', 'guest', 'developer') then
    raise exception 'bad role: %', coalesce(p_role, '(null)');
  end if;

  select u.id, u.email::text into v_target, v_email
  from auth.users u
  where lower(u.email::text) = lower(trim(p_email))
  limit 1;

  if v_target is null then
    raise exception 'no such account: %', coalesce(p_email, '(null)');
  end if;

  if p_role = 'developer' and p_enabled = false and v_target = v_uid then
    raise exception 'refuse to remove your own developer role';
  end if;

  if p_enabled then
    insert into public.user_roles (user_id, role) values (v_target, p_role)
    on conflict do nothing;
    if p_role = 'teacher' then
      insert into public.teacher_roles (user_id, email) values (v_target::text, v_email)
      on conflict (user_id) do update set email = excluded.email;
    end if;
  else
    delete from public.user_roles where user_id = v_target and role = p_role;
    if p_role = 'teacher' then
      delete from public.teacher_roles where user_id = v_target::text;
    end if;
  end if;

  return jsonb_build_object(
    'user_id', v_target,
    'email', v_email,
    'role', p_role,
    'enabled', p_enabled
  );
end;
$$;

comment on function public.admin_set_role(text, text, boolean) is
  '开发者专用：授予或撤销某账号的角色（teacher 会双写 teacher_roles）';


-- ============================================
-- 9. RPC 三：指定某个班由谁任教（仅 developer）
--    p_email 传空 = 解除归属（该班变回只有 developer 能改）
-- ============================================
create or replace function public.admin_set_class_teacher(p_class_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_email text;
  v_class_name text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.user_roles r
    where r.user_id = v_uid and r.role = 'developer'
  ) then
    raise exception 'developer only';
  end if;

  select c.name into v_class_name from public.classes c where c.id = p_class_id;
  if v_class_name is null then
    raise exception 'no such class: %', coalesce(p_class_id::text, '(null)');
  end if;

  if p_email is null or trim(p_email) = '' then
    update public.classes set teacher_id = null where id = p_class_id;
    return jsonb_build_object('class_id', p_class_id, 'name', v_class_name, 'email', null);
  end if;

  select u.id, u.email::text into v_target, v_email
  from auth.users u
  where lower(u.email::text) = lower(trim(p_email))
  limit 1;

  if v_target is null then
    raise exception 'no such account: %', p_email;
  end if;

  update public.classes set teacher_id = v_target where id = p_class_id;

  return jsonb_build_object('class_id', p_class_id, 'name', v_class_name, 'email', v_email);
end;
$$;

comment on function public.admin_set_class_teacher(uuid, text) is
  '开发者专用：指定某个班由哪个账号任教（空邮箱 = 解除归属）';


-- ============================================
-- 10. 授权：三个函数只给已登录用户执行，函数内部再验 developer
-- ============================================
grant execute on function public.admin_search_accounts(text) to authenticated;
grant execute on function public.admin_set_role(text, text, boolean) to authenticated;
grant execute on function public.admin_set_class_teacher(uuid, text) to authenticated;
revoke execute on function public.admin_search_accounts(text) from anon;
revoke execute on function public.admin_set_role(text, text, boolean) from anon;
revoke execute on function public.admin_set_class_teacher(uuid, text) from anon;


-- ============================================
-- 复核（执行后人工看一遍输出）
-- ============================================
\echo '== 1) 班级归属 =='
select c.name, c.syllabus, u.email as teacher_email
from public.classes c
left join auth.users u on u.id = c.teacher_id
order by c.name;

\echo '== 2) 角色分布 =='
select r.role, count(*) as n
from public.user_roles r
group by r.role
order by r.role;

\echo '== 3) 新增策略 =='
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('classes', 'student_data', 'vocab_overrides', 'vocab_releases')
order by tablename, policyname;
