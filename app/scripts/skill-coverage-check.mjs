// 知识库覆盖体检：用「页级索引自检」量化检索能否召回目标内容，替代人工抽查。
//   - 页召回率：抽样页 → 用该页索引关键词查询 → 能否召回该页（衡量关键词索引质量）
//   - Unit 指针：用 Unit 标题实词查询 → 能否召回该 Unit 起始页（衡量蒸馏考点接回原书的效果）
//   - 术语桥：用中文译名查询 → 经 zh→en 展开后能否召回相关页（衡量中英桥有效性）
// 每次改检索逻辑/索引后跑一次，未命中清单即为待补/待调之处。
//
// 用法：node scripts/skill-coverage-check.mjs --dir tb1=C:/tmp/tb1-pages [--dir tb2=...]
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const dirs = {};
let FULL = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir') {
    const [book, path] = args[++i].split('=');
    dirs[book] = path;
  } else if (args[i] === '--full') {
    FULL = true;   // 术语桥全量检查（不抽样），输出全部未命中
  }
}
if (!Object.keys(dirs).length) {
  console.error('usage: node scripts/skill-coverage-check.mjs --dir tb1=<index dir> [--dir tb2=...]');
  process.exit(1);
}

// 体检必须用线上真实的检索打分：先打包前端逻辑再动态 import
const tmp = mkdtempSync(join(tmpdir(), 'cov-'));
const bundle = join(tmp, 'retrieval.mjs');
execSync(
  `npx esbuild skill-site/src/retrieval.ts --bundle --format=esm --outfile=${bundle} --log-level=error`,
  { stdio: 'inherit' },
);
const { retrievePages, expandPages } = await import(pathToFileURL(bundle).href);

const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);

const books = Object.entries(dirs).map(([book, dir]) => {
  const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  return { book, pages: idx.pages ?? [], units: idx.units ?? {}, terms: idx.terms ?? [] };
});

const SAMPLE_PAGES = 150;
let allMiss = [];

for (const bk of books) {
  console.log(`\n================ ${bk.book} ================`);
  console.log(`pages=${bk.pages.length} units=${Object.keys(bk.units).length} terms=${bk.terms.length}`);

  // 1) 页召回率（关键词自检）
  const sample = shuffle(bk.pages).slice(0, SAMPLE_PAGES);
  let ok = 0;
  let checked = 0;
  const miss = [];
  for (const e of sample) {
    const kws = shuffle(e.k ?? []).slice(0, 4);
    if (kws.length < 2) continue;
    checked++;
    const hits = expandPages(retrievePages([bk], kws.join(' ')));
    if (hits.some((h) => Math.abs(h.page - e.p) <= 2)) ok++;
    else if (miss.length < 8) miss.push(`p${e.p} kw=[${kws.join(', ')}] -> ${hits.map((h) => h.page).join(',') || 'none'}`);
  }
  console.log(`\n[page recall] ${ok}/${checked} = ${((ok / Math.max(checked, 1)) * 100).toFixed(1)}%`);
  miss.forEach((m) => console.log('   MISS ' + m));

  // 2) Unit 指针
  const units = Object.entries(bk.units);
  if (units.length) {
    let uok = 0;
    const umiss = [];
    for (const [unit, u] of units) {
      const toks = (u.title.toLowerCase().match(/[a-z]{4,}/g) ?? []).slice(0, 6);
      if (!toks.length) continue;
      const hits = expandPages(retrievePages([bk], toks.join(' ')));
      if (hits.some((h) => Math.abs(h.page - u.page) <= 3)) uok++;
      else if (umiss.length < 6) umiss.push(`Unit ${unit} p.${u.page} "${u.title.slice(0, 50)}"`);
    }
    console.log(`\n[unit pointer] ${uok}/${units.length} = ${((uok / units.length) * 100).toFixed(1)}%`);
    umiss.forEach((m) => console.log('   MISS ' + m));
  }

  // 3) 术语桥：中文译名 → en → 是否召回页（--full 时全量检查，不看抽样）
  if (bk.terms.length) {
    const sampleTerms = FULL ? bk.terms : shuffle(bk.terms).slice(0, 60);
    let tok = 0;
    let checked = 0;
    const tmiss = [];
    for (const t of sampleTerms) {
      const ens = t.en.split(/[、,，/]/).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 4);
      if (!ens.length) continue;
      checked++;
      const hits = expandPages(retrievePages([bk], ens.join(' ')));
      if (hits.length) tok++;
      else if (tmiss.length < (FULL ? 40 : 6)) tmiss.push(`${t.zh} -> ${ens.join('/')}`);
    }
    console.log(`\n[term bridge${FULL ? ' · full' : ''}] ${tok}/${checked} = ${((tok / Math.max(checked, 1)) * 100).toFixed(1)}% 术语能召回到页`);
    tmiss.forEach((m) => console.log('   NOT-FOUND ' + m));
  }

  allMiss = allMiss.concat(miss, []);
}

console.log(`\n（未命中清单即为可改进点：补索引关键词、调打分权重、或补该页的蒸馏覆盖）`);
