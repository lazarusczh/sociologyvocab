#!/usr/bin/env node
/**
 * ManageBac dump 脱敏摘要器
 * ========================
 * 用途：`cf-managebac-login.mjs` 抓到的 `_ocrlab_out/mb-dump-*.json` 里含学生姓名，
 *      直接发出去不合适。本脚本把**人为信息掩掉**，只保留写选择器需要的结构：
 *        · 表格：表头（task 名）、行数、首行各单元格的"类型+长度"（不输出文本）
 *        · 输入框：按 (type/name/id/class) 分组计数，不含任何值
 *        · 按钮：标签文本与 id/class（按钮文案不是隐私）
 *        · 关键词扫描：Save Error / notification 等状态提示
 *
 * 用法：
 *   node scripts/mb-dump-summarize.mjs                    # 取 _ocrlab_out 下最新的 mb-dump-*.json
 *   node scripts/mb-dump-summarize.mjs <dump.json>
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.cwd());
const OUT_DIR = path.join(ROOT, '_ocrlab_out');

function newestDump() {
  const files = readdirSync(OUT_DIR)
    .filter((f) => /^mb-dump-.*\.json$/.test(f))
    .map((f) => ({ f, t: statSync(path.join(OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(OUT_DIR, files[0].f) : '';
}

/** 掩掉疑似姓名/邮箱的文本，只留"长度 + 首字母" */
function mask(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '(空)';
  if (/[@]/.test(t)) return `(email:${t.length})`;
  if (t.length > 40) return `(长文本:${t.length})`;
  // 中文姓名不能靠"首字母+长度"脱敏（会漏字），直接整体掩掉
  if (/[\u4e00-\u9fff]/.test(t)) return `(中文名:${t.length})`;
  return `${t[0]}…(${t.length})`;
}

const file = process.argv[2] ?? newestDump();
if (!file) {
  console.log('找不到 dump 文件：先跑 node scripts/cf-managebac-login.mjs');
  process.exit(2);
}
console.log(`摘要来源：${path.relative(ROOT, file)}\n`);

const d = JSON.parse(readFileSync(file, 'utf-8'));

console.log('== 页面 ==');
console.log(`url   : ${d.url}`);
console.log(`title : ${d.title}`);
console.log(`counts: 输入框 ${d.counts?.inputs} · 按钮 ${d.counts?.buttons} · 表格 ${d.counts?.tables}`);

console.log('\n== 标题/提示（按关键词）==');
const heads = d.headings ?? [];
for (const kw of ['error', 'save', 'notification', 'warning', 'invalid']) {
  const hit = heads.filter((h) => h.toLowerCase().includes(kw));
  if (hit.length) console.log(`  [${kw}] ` + hit.slice(0, 3).join(' | ').slice(0, 300));
}

console.log('\n== 表格（表头保留，单元格脱敏）==');
(d.tables ?? []).forEach((t, i) => {
  console.log(`  #${i} 表头(${t.headers?.length ?? 0}): ${(t.headers ?? []).slice(0, 8).join(' | ').slice(0, 300)}`);
  for (const row of (t.firstRows ?? []).slice(0, 3)) {
    console.log(`      行: ${row.slice(0, 8).map(mask).join(' , ').slice(0, 300)}`);
  }
});

console.log('\n== 输入框（按属性分组，值一律不输出）==');
const groups = new Map();
for (const inp of d.inputs ?? []) {
  const key = [inp.tag, inp.type, inp.name, inp.id, inp.placeholder].filter(Boolean).join(' | ');
  const g = groups.get(key) ?? { n: 0, filled: 0 };
  g.n += 1;
  if (inp.filled) g.filled += 1;
  groups.set(key, g);
}
[...groups.entries()]
  .sort((a, b) => b[1].n - a[1].n)
  .forEach(([k, g]) => console.log(`  ${String(g.n).padStart(3)} 个（已填 ${g.filled}）  ${k.slice(0, 160)}`));

console.log('\n== 按钮（文案与 id/class）==');
const seen = new Set();
for (const b of d.buttons ?? []) {
  const label = (b.text ?? '').slice(0, 40);
  const key = `${label}|${b.id ?? ''}|${b.class ?? ''}`;
  if (seen.has(key) || !label) continue;
  seen.add(key);
  console.log(`  ${label}${b.id ? '  #' + b.id : ''}${b.class ? '  .' + String(b.class).slice(0, 60) : ''}`);
  if (seen.size > 30) break;
}

console.log('\n== 链接（前 25 条，只保留路径形态）==');
for (const l of (d.links ?? []).slice(0, 25)) {
  const href = String(l.h ?? '');
  console.log(`  ${(l.t ?? '').slice(0, 40)} → ${href.replace(/[0-9]{4,}/g, ':id').slice(0, 90)}`);
}
