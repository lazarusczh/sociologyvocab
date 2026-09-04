// 切题 md → 学生「历年真题（按考点）」展示数据
// 用法：node scripts/generate-pastpaper-topics.mjs
// 读取项目根目录 5 份切题 md，产出 app/public/pastpaper-topics.json
// 说明：展示链路与组卷器 question-bank.json 相互独立；md 保留 Specimen 题供资料展示。
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const OUT = join(here, '..', 'public', 'pastpaper-topics.json');

const FILES = [
  { label: 'Paper 1', file: 'Paper1真题-按考点.md' },
  { label: 'Paper 2', file: 'Paper2真题-历年切题(至S26).md' },
  { label: 'Paper 3', file: 'Paper3真题-历年切题(至S26).md' },
  { label: 'Paper 4 · Globalisation', file: 'Paper4Globalisation真题-历年切题(至S26).md' },
  { label: 'Paper 4 · Media', file: 'Paper4Media真题-历年切题(至S26).md' },
];

// ---------- 行解析：`- (来源) 题干 [分值]（备注）` / P4 的 `- [来源] '…' Evaluate…` ----------
function parseRow(raw) {
  const line = raw.trim().replace(/^[-*]\s+/, '');
  const m = line.match(/^\((.*?)\)\s*([\s\S]*)$/) || line.match(/^\[(.*?)\]\s*([\s\S]*)$/);
  if (!m) return null; // 元信息/说明行，非题目
  const src = m[1].trim();
  let body = m[2].trim();
  if (!body) return null;

  // 分值 [n] 或 [n+m]（取首个出现，前文已无方括号来源）
  let marks = '';
  const mm = body.match(/\[(\d+(?:\s*\+\s*\d+)?)\]/);
  if (mm) {
    marks = mm[1].replace(/\s+/g, '');
    body = (body.slice(0, mm.index) + body.slice(mm.index + mm[0].length)).trim();
  }

  // 备注
  let note = '';
  const wi = body.indexOf('⚠');
  if (wi > -1) {
    note = body.slice(wi).trim();
    body = body.slice(0, wi).trim();
  }
  const pm = body.match(/[（(][^（()）]{1,80}[）)]\s*$/);
  if (pm) {
    note = (note ? note + ' ' : '') + pm[0].trim();
    body = body.slice(0, pm.index).trim();
  }

  // statement：扫描收引号（其后允许标点/空格，之后须为空或以大写/（ 开头，排除句中撇号）
  let statement = '';
  let instruction = body;
  if (/^[‘“'"]/.test(body)) {
    const content = body.replace(/^[‘“'"][\s]*/, '');
    const closeRe = /['”’]/g;
    let m;
    let closedAt = -1;
    while ((m = closeRe.exec(content))) {
      const tail = content.slice(m.index + 1).replace(/^[\s.,;:!?]+/, '');
      if (!tail || /^[A-Z（(]/.test(tail)) { closedAt = m.index; break; }
    }
    if (closedAt > -1) {
      statement = content.slice(0, closedAt).trim();
      instruction = content.slice(closedAt + 1).trim().replace(/^[\s.,;:!?]+/, '');
    } else {
      statement = content.trim(); // 有开引号但缺收引号（个别笔误行）
      instruction = '';
    }
  } else {
    instruction = body;
  }

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  return { src, marks, statement: norm(statement), instruction: norm(instruction), note: norm(note) };
}

// ---------- 标题 → 树 ----------
// 清洗给"组织者自己看"的标题备注（页面只留考点本体），如 "——独立 Topic（暂 1 题，为未来新卷预留）"
function cleanTitle(t) {
  return t
    .replace(/——独立\s*Topic\s*（[^）]*）/g, '')
    .replace(/——\s*独立\s*[^（]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTopics(lines) {
  const root = { title: '', level: 1, items: [], children: [], skip: false };
  const stack = [root];
  for (const raw of lines) {
    const h = raw.match(/^(#{2,6})\s+(.*)$/); // H1 为文件名标题，不入树
    if (h) {
      const lvl = h[1].length;
      const title = cleanTitle(h[2].trim());
      while (stack.length > 1 && stack[stack.length - 1].level >= lvl) stack.pop();
      // 元信息区（统计速览/口径确认/待办/增补等）不转给学生展示
      const skip = stack.some((n) => n.skip) || /附|附录|统计速览|已确认口径|待办|增补/.test(title);
      const node = { title, level: lvl, items: [], children: [], skip };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (/^\s*[-*]\s+/.test(raw)) {
      if (stack.some((n) => n.skip)) continue;
      const item = parseRow(raw);
      if (item) stack[stack.length - 1].items.push(item);
    }
  }
  return root.children;
}

// 去除空节点（标题下无题也保留标题无妨；仅清理没有任何 children/items 的节点）
function prune(node) {
  node.children = node.children.map(prune).filter((c) => c.items.length > 0 || c.children.length > 0);
  return node;
}
function count(node) {
  node.count = node.items.length + node.children.reduce((s, c) => s + count(c), 0);
  return node.count;
}

const papers = [];
let total = 0;
for (const f of FILES) {
  const text = readFileSync(join(ROOT, f.file), 'utf-8');
  const lines = text.split(/\r?\n/);
  const titleLine = lines.find((l) => /^#\s/.test(l));
  const topics = buildTopics(lines).map(prune).filter((t) => t.items.length > 0 || t.children.length > 0);
  topics.forEach(count);
  const n = topics.reduce((s, t) => s + t.count, 0);
  total += n;
  papers.push({ label: f.label, file: f.file, title: titleLine ? titleLine.replace(/^#\s+/, '').trim() : f.label, total: n, topics });
  console.log(`${f.label.padEnd(22)} ${f.file.padEnd(42)} rows=${n} tops=${topics.length} first=${topics[0]?.title} it0=${topics[0]?.items.length}`);
}
console.log(`TOTAL rows=${total}`);
const out = { generatedAt: new Date().toISOString(), papers };
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('written', OUT);
