-- OCR 录入记录：列表不必再拉转写正文（2026-09-15）
--
-- 症状（教师实测）：OCR 界面的「录入记录」载入特别慢、点「刷新」也慢。
-- 原因：列表查询 `select id, label, page_name, text, …` 把 60 条**整页转写正文**一起拉回来
--       （正文动辄几千字，一次就是几百 KB），而列表实际只用到 备注 / 时间 / 字数。
--
-- 处理：补一个由触发器维护的 text_len，列表只取元信息；正文改为点「载入」时按 id 单条取。
--       这样列表的传输量从"几百 KB"降到"几 KB"，且不丢「N 字」这个显示。
--
-- 幂等：可重复执行。

alter table public.ocr_pages add column if not exists text_len integer;

comment on column public.ocr_pages.text_len is '转写正文字数（触发器维护，供列表显示，避免列表拉正文）';

-- 新增/更新时自动写入字数（与既有的 updated_at 触发器并存，互不影响）
create or replace function public.ocr_pages_set_len()
returns trigger
language plpgsql
as $$
begin
  new.text_len := length(coalesce(new.text, ''));
  return new;
end;
$$;

drop trigger if exists ocr_pages_set_len_trg on public.ocr_pages;
create trigger ocr_pages_set_len_trg
  before insert or update on public.ocr_pages
  for each row execute function public.ocr_pages_set_len();

-- 回填历史行（update 本身会触发上面的触发器，即顺手写好新值）
update public.ocr_pages set text_len = length(coalesce(text, '')) where text_len is null;
