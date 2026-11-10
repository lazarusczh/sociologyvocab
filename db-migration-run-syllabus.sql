-- ============================================================================
-- 让「组卷记录」与「测验/作业」记住自己属于哪个 syllabus
--
-- 为什么需要：
--   ManageBac 短码形如 `A1-0712`，年级位由 `papers` 推（P1/P2 → A1、P3/P4 → A2）。
--   0495（IGCSE）只有 Paper 1 / Paper 2，会被这条规则判成 A1 —— 短码张冠李戴，
--   而且 0495 的班与 A1 的班在 ManageBac 里是两个不同的成绩册，错配会直接写错分。
--
--   只靠教师界面上的当前大纲（前端 state）也能算对，但那是一次性的：
--   记录落库后没有归属，别的教师打开同一条记录、或者刷新页面，就又回到「按卷数猜」。
--   ⇒ 归属必须落到行上。
--
-- 影响面：
--   `grouper_runs` 与 `quizzes` 各加一列，默认 '9699'。现有行全是 9699，语义正确。
--   写入端（createGrouperRun / createQuiz）显式带上；读取端（listGrouperRuns / listQuizzes）
--   自带 `select('*')`，无需改动即可读到。
-- ============================================================================

alter table public.grouper_runs
  add column if not exists syllabus text not null default '9699';

alter table public.quizzes
  add column if not exists syllabus text not null default '9699';

-- 现有行兜底（默认值已覆盖，这里只防御历史上被写成 null 的情况）
update public.grouper_runs set syllabus = '9699' where syllabus is null;
update public.quizzes set syllabus = '9699' where syllabus is null;

-- 按 syllabus 检索用（教师端按大纲筛选记录时会走）
create index if not exists grouper_runs_syllabus_idx on public.grouper_runs (syllabus);
create index if not exists quizzes_syllabus_idx on public.quizzes (syllabus);

\echo '== 1) 两表 syllabus 分布'
select 'grouper_runs' as t, syllabus, count(*) from public.grouper_runs group by syllabus
union all
select 'quizzes' as t, syllabus, count(*) from public.quizzes group by syllabus
order by t, syllabus;
