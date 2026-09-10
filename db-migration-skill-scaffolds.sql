-- 章节答题脚手架：从蒸馏教材章抽取的 Mental Models / Anti-patterns / Key Takeaways，
-- 作答时按命中的章注入 system，把教师的答题口径带给模型（对弱兜底档尤其有效）。
-- 与知识库其他表一致：仅登录用户可读。

create table if not exists skill_scaffolds (
  book       text not null,
  chapter    text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (book, chapter)
);

alter table skill_scaffolds enable row level security;

drop policy if exists "skill_scaffolds read for authenticated" on skill_scaffolds;
create policy "skill_scaffolds read for authenticated"
  on skill_scaffolds for select
  to authenticated
  using (true);
