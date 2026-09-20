// 定义题踩分点 → Supabase 导入（幂等：按 id upsert）
//
//   node scripts/definition-import.mjs --in data/definition-keypoints.json --out C:/tmp/definition.sql
//   psql "postgresql://postgres@<host>:5432/postgres" -w -v ON_ERROR_STOP=1 -f C:/tmp/definition.sql
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let input = 'data/definition-keypoints.json';
let out = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--in') input = args[++i];
  else if (args[i] === '--out') out = args[++i];
}
if (!out) {
  console.error('usage: node definition-import.mjs [--in <json>] --out <sql>');
  process.exit(1);
}

const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;
const arr = (xs) => {
  const list = (xs ?? []).filter((x) => x !== null && x !== undefined && String(x) !== '');
  return list.length ? `array[${list.map(q).join(', ')}]::text[]` : `'{}'::text[]`;
};
const slug = (t, i) => {
  const s = String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || `item-${i}`;
};

const items = JSON.parse(readFileSync(input, 'utf8'));
const lines = ['begin;'];
let n = 0;
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  if (!it?.term || !Array.isArray(it.keypoints) || !it.keypoints.length) continue;
  const units = Array.isArray(it.unit) ? it.unit : it.unit ? [it.unit] : [];
  lines.push(
    `insert into definition_items (id, term, chinese, paper, units, reference, keypoints, bonus, sources, source_notes, source_defs, beta, active) values (` +
      `${q(slug(it.term, i))}, ${q(it.term)}, ${q(it.chinese)}, ${q(it.paper)}, ${arr(units)}, ${q(it.reference)}, ` +
      `${q(JSON.stringify(it.keypoints))}::jsonb, ${q(JSON.stringify(it.bonus ?? []))}::jsonb, ` +
      `${arr(it.sources)}, ${q(JSON.stringify(it.source_notes ?? {}))}::jsonb, ` +
      `${q(JSON.stringify(it.source_defs ?? {}))}::jsonb, true, true) ` +
      `on conflict (id) do update set term = excluded.term, chinese = excluded.chinese, paper = excluded.paper, ` +
      `units = excluded.units, reference = excluded.reference, keypoints = excluded.keypoints, ` +
      `bonus = excluded.bonus, sources = excluded.sources, source_notes = excluded.source_notes, ` +
      `source_defs = excluded.source_defs, updated_at = now();`,
  );
  n++;
}
lines.push('commit;');
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`wrote ${out} — ${n} items (${(lines.join('\n').length / 1024).toFixed(0)} KB)`);
