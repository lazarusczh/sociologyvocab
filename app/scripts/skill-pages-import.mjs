// 把 skill-pdf-pages.py 的产物（页级原文 + 索引）导入 Supabase。
// 生成幂等 SQL（ON CONFLICT DO UPDATE），再用 psql -f 执行：
//   node scripts/skill-pages-import.mjs --dir tb1=C:/tmp/tb1-pages --dir tb2=C:/tmp/tb2-pages --out C:/tmp/skill-pages.sql
//   psql "..." -w -v ON_ERROR_STOP=1 -f C:/tmp/skill-pages.sql
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dirs = {};
let out = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir') {
    const [book, path] = args[++i].split('=');
    dirs[book] = path;
  } else if (args[i] === '--out') {
    out = args[++i];
  }
}
if (!out || !Object.keys(dirs).length) {
  console.error('usage: node skill-pages-import.mjs --dir tb1=<dir> [--dir tb2=<dir>] --out <sql>');
  process.exit(1);
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const lines = ['begin;'];
let pageCount = 0;

for (const [book, dir] of Object.entries(dirs)) {
  // 1) 索引：整份 jsonb 一行
  const indexRaw = readFileSync(join(dir, 'index.json'), 'utf8');
  lines.push(
    `insert into skill_page_index (book, data) values (${q(book)}, ${q(indexRaw)}::jsonb) ` +
      `on conflict (book) do update set data = excluded.data, updated_at = now();`,
  );

  // 2) 页原文：按章分块文件 → 逐页一行
  const pagesDir = join(dir, 'pages');
  for (const f of readdirSync(pagesDir).filter((x) => x.endsWith('.json'))) {
    const blob = JSON.parse(readFileSync(join(pagesDir, f), 'utf8'));
    for (const p of blob.pages) {
      lines.push(
        `insert into skill_pages (book, page, chapter, text) values ` +
          `(${q(book)}, ${p.p}, ${q(blob.chapter ?? '')}, ${q(p.t)}) ` +
          `on conflict (book, page) do update set chapter = excluded.chapter, text = excluded.text;`,
      );
      pageCount++;
    }
  }
  console.log(`  ${book}: index + pages prepared`);
}

lines.push('commit;');
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`wrote ${out} (${pageCount} pages, ${(lines.join('\n').length / 1024 / 1024).toFixed(2)} MB)`);
