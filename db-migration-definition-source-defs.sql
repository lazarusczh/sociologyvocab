-- 定义题：给 definition_items 增加 source_defs（各来源英文原文）
--
-- 用途：判分时把词库/教材/0495 的**英文原文**一并给模型，让学生答案（英文）与英文原文做同语言比对，
--       避免「英文原文 → 中文摘要 → 中文要素」两次转译丢信息导致的误判（详见
--       `定义题-总括式主干现状与改动清单.md`）。
-- 幂等：可重复执行。
-- 执行：psql "<conn>" -w -v ON_ERROR_STOP=1 -f db-migration-definition-source-defs.sql

alter table definition_items add column if not exists source_defs jsonb not null default '{}'::jsonb;

comment on column definition_items.source_defs is
  '各来源英文原文，键为来源 key（main / tb1 / tb2 / igcse0495）；判分提示词用它做同语言语义参照，不参与计分';
