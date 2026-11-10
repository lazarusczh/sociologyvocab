// 一次性脚本：把 0495 补充词条并入云端 v100（902 条），产出 v101 的 data
// 用法：node scripts/build-v101.mjs
// 产出：
//   .tmp0495/v101.json            合并后的完整数组（1024 条）
//   app/public/vocab-data.json    同步更新内置兜底词库
//   .tmp0495/publish-v101.sql     发布用 SQL（直接 insert 到 vocab_releases）
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const root = resolve(app, '..');

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const v100 = JSON.parse(stripBom(readFileSync(resolve(app, '.tmp0495/v100.json'), 'utf8')));
const supplement = JSON.parse(readFileSync(resolve(here, '_0495_vocab_items.json'), 'utf8'));

if (!Array.isArray(v100) || v100.length !== 902) {
  throw new Error(`v100 条数异常：${v100.length}（预期 902）`);
}
if (!Array.isArray(supplement) || supplement.length !== 122) {
  throw new Error(`补充条数异常：${supplement.length}（预期 122）`);
}

const existingIds = new Set(v100.map((i) => i.id));
const clash = supplement.filter((i) => existingIds.has(i.id));
if (clash.length) throw new Error(`id 冲突：${clash.map((i) => i.term).join(', ')}`);

// 同名同卷同主题重复检查（补充 vs 云端）
const norm = (s) => (s || '').trim().toLowerCase();
const keyOf = (i) => [norm(i.term), i.paper, norm(i.category)].join('|');
const cloudKeys = new Set(v100.map(keyOf));
const dup = supplement.filter((i) => cloudKeys.has(keyOf(i)));
if (dup.length) throw new Error(`同名重复：${dup.map((i) => i.term).join(', ')}`);

const merged = [...v100, ...supplement];

const idSet = new Set(merged.map((i) => i.id));
if (idSet.size !== merged.length) throw new Error('合并后存在重复 id');

const count = (arr) => {
  const out = {};
  for (const i of arr) out[i.paper] = (out[i.paper] || 0) + 1;
  return out;
};

console.log(`云端 v100：${v100.length} 条`);
console.log(`补充：${supplement.length} 条（syllabus=0495）`);
console.log(`合并后：${merged.length} 条`);
console.log('按卷：', count(merged));
console.log('9699 可见：', merged.filter((i) => !i.syllabus).length, '条');
console.log('0495 专属：', merged.filter((i) => i.syllabus === '0495').length, '条');

writeFileSync(resolve(app, '.tmp0495/v101.json'), JSON.stringify(merged, null, 2), 'utf8');
writeFileSync(resolve(app, 'public/vocab-data.json'), JSON.stringify(merged, null, 2) + '\n', 'utf8');

// 生成发布 SQL。data 用 $$ 包裹以免 JSON 里的引号转义；JSON 内容里若出现 $$ 需换定界符。
const json = JSON.stringify(merged);
const dollar = json.includes('$$') ? '$vocab$' : '$$';
const sql = `-- v101：9699 基础词库并入 0495 补充词条（122 条，带 syllabus='0495'）
-- 生成于 ${new Date().toISOString()}
-- 全部 ${merged.length} 条都挂在 9699 这条链上；0495 专属条目由运行时 itemBelongsTo 过滤，
-- 9699 视图看不到它们。这样只有一条版本链，投影模式与独立模式共用。
begin;

insert into public.vocab_releases (version, data, note, unit_order, surname_overrides, syllabus)
select
  101,
  ${dollar}${json}${dollar}::jsonb,
  '0495 补充词条 122 条入库（P1 84 / P2 38），9699 视图不受影响',
  unit_order,
  surname_overrides,
  '9699'
from public.vocab_releases
where version = 100 and syllabus = '9699';

commit;

-- 复核
select version, syllabus, jsonb_array_length(data) as items, length(data::text) as bytes
from public.vocab_releases order by version desc limit 3;
select count(*) filter (where i->>'syllabus' = '0495') as only0495
from public.vocab_releases, jsonb_array_elements(data) i
where version = 101 and syllabus = '9699';
`;
writeFileSync(resolve(app, '.tmp0495/publish-v101.sql'), sql, 'utf8');
console.log('已写出 .tmp0495/v101.json、public/vocab-data.json、.tmp0495/publish-v101.sql');
