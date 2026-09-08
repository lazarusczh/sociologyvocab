// 把 book-to-skill 产物（markdown）转成知识站前端用的结构化 JSON
//
// 用法：
//   多本（推荐）：node scripts/skill-md-json.mjs <manifest.json> <输出json>
//   单本（兼容）：node scripts/skill-md-json.mjs <skill目录> <输出json>
//
// manifest 格式（dir 相对 manifest 所在目录解析）：
// {
//   "books": [
//     { "slug": "textbook", "label": "教材 · Cambridge 9699", "kind": "教材", "dir": "C:/path/to/9699textbook1" },
//     { "slug": "guide",    "label": "教辅 · 某某",          "kind": "教辅", "dir": "../somewhere/guide" }
//   ]
// }
//
// 输出结构：
// {
//   generated,
//   books: [{ slug, label, kind,
//             chapters: [{ id: "<slug>/<file>", file, title, tagline, sections }],
//             glossary: [{ term, zh, def, chapters }],
//             patterns: [{ heading, lines }],
//             cheatsheet: [{ heading, lines }] }]
// }
// 说明：每本各自保留词汇表/答题模式/速查表（重复无所谓），章节 id 带 slug 前缀避免跨本撞名。
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';

const [, , input, outFile] = process.argv;
if (!input || !outFile) {
  console.error('用法: node scripts/skill-md-json.mjs <manifest.json 或 skill目录> <输出json>');
  process.exit(1);
}

// 清洗一行 markdown：去掉行内粗体/斜体/反引号/链接语法，保留纯文本
function cleanInline(line) {
  return line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1') // *it* -> it
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*#+\s*/, '')
    .replace(/\|/g, ' · ') // 表格管道
    .replace(/^\s*[-*]\s+/, '• ')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .trim();
}

// 把整段 markdown 文本按 "## " 二级标题切成 sections；每个 section 保留标题与行
function splitSections(md) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.lines.length) sections.push({ ...cur, lines: cur.lines });
    else if (cur) sections.push(cur); // 保留仅有标题的空节避免丢章节骨架
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) {
      flush();
      cur = { heading: cleanInline(line), lines: [] };
    } else if (cur) {
      const t = cleanInline(line);
      if (t) cur.lines.push(t);
    }
  }
  flush();
  return sections;
}

const readIfExists = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// glossary.md 每行 "**Term** — 中文释义 (Ch 1, Ch 5)"
function parseGlossary(file) {
  const out = [];
  for (const raw of readIfExists(file).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^\*\*(.+?)\*\*\s*[—–:-]\s*(.+)$/);
    if (!m) continue;
    const term = m[1].trim();
    const rest = m[2];
    const chm = rest.match(/\(([^)]*Ch\s*\d[^)]*)\)\s*$/i);
    let def = rest;
    const chRefs = [];
    if (chm) {
      def = rest.slice(0, chm.index).trim();
      const parts = chm[1].split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        const dm = p.match(/Ch\.?\s*(\d+)/i);
        if (dm) chRefs.push('ch' + String(dm[1]).padStart(2, '0'));
      }
    }
    out.push({ term, zh: term, def: cleanInline(def), chapters: chRefs });
  }
  return out;
}

const docSections = (file) =>
  splitSections(readIfExists(file)).map((s) => ({ heading: s.heading, lines: s.lines }));

function buildBook({ slug, label, kind, dir }) {
  const chaptersDir = join(dir, 'chapters');
  if (!existsSync(chaptersDir)) throw new Error(`缺少 chapters 目录: ${chaptersDir}`);

  const chapters = readdirSync(chaptersDir)
    .filter((x) => x.endsWith('.md'))
    .sort()
    .map((f) => {
      const md = readFileSync(join(chaptersDir, f), 'utf8');
      const first = (md.split(/\r?\n/)[0] ?? '').replace(/^#\s*/, '');
      return {
        id: `${slug}/${f.replace(/\.md$/, '')}`, // 加 slug 前缀，跨本不撞名
        file: f,
        title: cleanInline(first) || f,
        tagline: '',
        sections: splitSections(md),
      };
    });

  return {
    slug,
    label: label || slug,
    kind: kind || '教材',
    chapters,
    glossary: parseGlossary(join(dir, 'glossary.md')),
    patterns: docSections(join(dir, 'patterns.md')),
    cheatsheet: docSections(join(dir, 'cheatsheet.md')),
  };
}

function loadManifest(p) {
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const base = dirname(resolve(p));
  const books = (raw.books ?? []).map((b) => ({ ...b, dir: resolve(base, b.dir) }));
  if (!books.length) throw new Error('manifest 里没有 books');
  return books;
}

let books;
if (input.toLowerCase().endsWith('.json')) {
  books = loadManifest(input).map(buildBook);
} else {
  // 兼容旧用法：单目录 = 一本书
  const dir = resolve(input);
  const slug = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'book';
  books = [buildBook({ slug, label: basename(dir), kind: '教材', dir })];
}

const out = { generated: new Date().toISOString().slice(0, 10), books };
writeFileSync(outFile, JSON.stringify(out, null, 1), 'utf8');

console.log(`已生成 ${outFile}`);
for (const b of out.books) {
  console.log(
    `  [${b.kind}] ${b.label} (${b.slug})：章节 ${b.chapters.length}、术语 ${b.glossary.length}、patterns ${b.patterns.length}、cheatsheet ${b.cheatsheet.length}`,
  );
}
