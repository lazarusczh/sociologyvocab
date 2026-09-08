-- ============================================
-- syllabus 维度：vocab_releases 增加 syllabus 列（默认 '9699'）
-- classes.syllabus 补默认值并回填存量
-- 幂等，可重复执行
-- ============================================

-- 1. vocab_releases 增加 syllabus 列（常量 default，PG 会自动回填存量行为 '9699'）
alter table public.vocab_releases
  add column if not exists syllabus text not null default '9699';

-- 2. 兜底回填（保险起见，理论上上一步已回填）
update public.vocab_releases set syllabus = '9699' where syllabus is null;

-- 3. classes.syllabus 补默认值（字段已存在，仅影响新插入行）
alter table public.classes
  alter column syllabus set default '9699';

-- 4. 回填 classes 存量空 syllabus
update public.classes set syllabus = '9699' where syllabus is null;
