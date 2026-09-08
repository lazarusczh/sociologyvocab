// 把 skill-content.json 生成幂等 INSERT SQL（skill_content 表，version = max+1）
// 用法: node scripts/skill-import-sql.mjs <json> <输出sql>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , jsonFile, outSql] = process.argv;
if (!jsonFile || !outSql) {
  console.error('用法: node scripts/skill-import-sql.mjs <json> <输出sql>');
  process.exit(1);
}

const data = readFileSync(jsonFile, 'utf8').trim();
const note = `9699textbook1 蒸馏内容导入 ${new Date().toISOString().slice(0, 10)}`;

const sql = `-- skill_content 幂等导入（每次执行自动 version+1）
insert into public.skill_content (version, data, note)
select coalesce((select max(version) from public.skill_content), 0) + 1,
       '${data.replace(/'/g, "''")}'::jsonb,
       '${note.replace(/'/g, "''")}'
where not exists (
  select 1 from public.skill_content
  where note = '${note.replace(/'/g, "''")}'
);
`;

writeFileSync(outSql, sql, 'utf8');
console.log(`已生成 ${outSql}`);
