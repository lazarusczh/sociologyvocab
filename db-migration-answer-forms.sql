-- ============================================
-- 服务端答案判定物化：vocab_answer_forms + normalize_answer()
--
-- 用途与流程见项目根《实时多人在线功能规划.md》第九节
--   「附：vocab_answer_forms 物化的具体流程」
-- 幂等，可重复执行：
--   $env:PGPASSFILE="$env:USERPROFILE\.pgpass"
--   psql $conn -w -v ON_ERROR_STOP=1 -f db-migration-answer-forms.sql
-- ============================================

-- ---------------------------------------------------------------
-- 1. 归一化函数：必须与前端 app/src/lib/answers.ts 的 normalizeKey 严格等价
--
--    JS 的顺序：normalize('NFD') 去变音 -> toLowerCase -> & 换成 and
--              -> 词内的 -isation 换成 -ization -> -ise 换成 -ize
--              -> 删掉所有非 [a-z0-9] 字符
--
--    两个必须注意的地方：
--    a) PostgreSQL 的词边界是 \y，不是 \b。\b 在 ARE 里是退格符，
--       照抄 JS 的 \b 不会报错、结果却不同 —— 这是最容易静默踩到的坑。
--    b) 变音用 translate 显式映射「NFD 可分解」的字符。
--       不可分解的字符（ø ß æ œ đ þ 等）在 JS 里也会被最后的 [^a-z0-9] 删掉，
--       所以这里同样不映射，两端口径才一致（不要好心把它们映射成 o/s/ae）。
--
--    实测当前词库中出现的拉丁重音字符只有 è(U+00E8) 与 É(U+00C9)；
--    下表是 Latin-1 可分解重音的完整覆盖。若将来加入 Latin Extended-A 字符
--    （ā ń ő ǔ 等），需同步扩展下表，并跑一次对拍体检（见 app/scripts/answer-forms-check.mjs）。
-- ---------------------------------------------------------------
create or replace function public.normalize_answer(p text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 lower(translate(coalesce(p, ''),
                   'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžƠơƯưǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮȯȰȱȲȳḀḁḂḃḄḅḆḇḈḉḊḋḌḍḎḏḐḑḒḓḔḕḖḗḘḙḚḛḜḝḞḟḠḡḢḣḤḥḦḧḨḩḪḫḬḭḮḯḰḱḲḳḴḵḶḷḸḹḺḻḼḽḾḿṀṁṂṃṄṅṆṇṈṉṊṋṌṍṎṏṐṑṒṓṔṕṖṗṘṙṚṛṜṝṞṟṠṡṢṣṤṥṦṧṨṩṪṫṬṭṮṯṰṱṲṳṴṵṶṷṸṹṺṻṼṽṾṿẀẁẂẃẄẅẆẇẈẉẊẋẌẍẎẏẐẑẒẓẔẕẖẗẘẙẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰựỲỳỴỵỶỷỸỹKÅḀḁḂḃḄḅḆḇḈḉḊḋḌḍḎḏḐḑḒḓḔḕḖḗḘḙḚḛḜḝḞḟḠḡḢḣḤḥḦḧḨḩḪḫḬḭḮḯḰḱḲḳḴḵḶḷḸḹḺḻḼḽḾḿṀṁṂṃṄṅṆṇṈṉṊṋṌṍṎṏṐṑṒṓṔṕṖṗṘṙṚṛṜṝṞṟṠṡṢṣṤṥṦṧṨṩṪṫṬṭṮṯṰṱṲṳṴṵṶṷṸṹṺṻṼṽṾṿẀẁẂẃẄẅẆẇẈẉẊẋẌẍẎẏẐẑẒẓẔẕẖẗẘẙẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰựỲỳỴỵỶỷỸỹÅ',
                   'aaaaaaceeeeiiiinooooouuuuyaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccddeeeeeeeeeegggggggghhiiiiiiiiijjkkllllllnnnnnnoooooorrrrrrssssssssttttuuuuuuuuuuuuwwyyyzzzzzzoouuaaiioouuuuuuuuuuaaaaggkkoooojggnnaaaaaaeeeeiiiioooorrrruuuusstthhaaeeooooooooyyaabbbbbbccddddddddddeeeeeeeeeeffgghhhhhhhhhhiiiikkkkkkllllllllmmmmmmnnnnnnnnoooooooopppprrrrrrrrssssssssssttttttttuuuuuuuuuuvvvvwwwwwwwwwwxxxxyyzzzzzzhtwyaaaaaaaaaaaaaaaaaaaaaaaaeeeeeeeeeeeeeeeeiiiioooooooooooooooooooooooouuuuuuuuuuuuuuyyyyyyyykaaabbbbbbccddddddddddeeeeeeeeeeffgghhhhhhhhhhiiiikkkkkkllllllllmmmmmmnnnnnnnnoooooooopppprrrrrrrrssssssssssttttttttuuuuuuuuuuvvvvwwwwwwwwwwxxxxyyzzzzzzhtwyaaaaaaaaaaaaaaaaaaaaaaaaeeeeeeeeeeeeeeeeiiiioooooooooooooooooooooooouuuuuuuuuuuuuuyyyyyyyya')),
                 '&', 'and', 'g'),
               '\y([a-z]+)isation\y', '\1ization', 'g'),
             '\y([a-z]+)ise\y', '\1ize', 'g'),
           '[^a-z0-9]', '', 'g')
$$;

-- 批量版：供对拍 / 体检脚本调用（PostgREST 只能调函数，不能跑任意 SQL）。
-- 输入顺序与输出顺序严格一一对应。
create or replace function public.normalize_answer_batch(p text[])
returns text[]
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(array_agg(public.normalize_answer(x) order by ord), '{}')
  from unnest(coalesce(p, '{}'::text[])) with ordinality as t(x, ord)
$$;

grant execute on function public.normalize_answer(text) to anon, authenticated;
grant execute on function public.normalize_answer_batch(text[]) to anon, authenticated;

-- ---------------------------------------------------------------
-- 2. 判定表：存「归一化之后的键」（不是原始写法）
--    由教师端「发布词库」时全表重建（见 app/src/lib/cloud.ts 的 publishVocab）
-- ---------------------------------------------------------------
create table if not exists public.vocab_answer_forms (
  term_id text not null,
  form_normalized text not null,
  updated_at timestamptz default now()
);

alter table public.vocab_answer_forms enable row level security;

-- 教师可读写（发布时重建：先清空再写入）。
-- 学生无任何策略 = 读不到；将来服务端判定走 security definer 的 RPC 读取。
drop policy if exists "vocab_answer_forms_teacher" on public.vocab_answer_forms;
create policy "vocab_answer_forms_teacher" on public.vocab_answer_forms
  for all
  using (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'))
  with check (exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'teacher'));
