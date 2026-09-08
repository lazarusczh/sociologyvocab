// 把 9699textbook1 蒸馏 skill 产物（markdown）转成知识站前端用的结构化 JSON
// 用法: node scripts/skill-md-json.mjs <skill目录> <输出json>
// 输出结构:
// {
//   generated: string,
//   chapters: [{ id, file, title, tagline, sections: [{ heading, lines: string[] }] }],
//   glossary: [{ term, zh, def, chapters: string[] }],
//   patterns: [{ heading, lines }],
//   cheatsheet: [{ heading, lines }],
// }
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , skillDir, outFile] = process.argv;
if (!skillDir || !outFile) {
  console.error('用法: node scripts/skill-md-json.mjs <skill目录> <输出json>');
  process.exit(1);
}

const read = (p) => readFileSync(join(skillDir, p), 'utf8');

// 清洗一行 markdown：去掉行内粗体/斜体/反引号/链接语法，保留纯文本
function cleanInline(line) {
  return line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1') // *it* -> it
    .replace(/`([^`]+)`/g, '$1') // `code` -> code
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

// 章节 md 文件名 -> 从文件首行 "# Chapter N: X — 副题" 提取章节名
const chapters = [];
for (const f of readdirSync(join(skillDir, 'chapters')).filter((x) => x.endsWith('.md')).sort()) {
  const md = read(join('chapters', f));
  const first = (md.split(/\r?\n/)[0] ?? '').replace(/^#\s*/, '');
  chapters.push({
    id: f.replace(/\.md$/, ''),
    file: f,
    title: cleanInline(first) || f,
    tagline: '',
    sections: splitSections(md),
  });
}

// glossary.md 每行 "**Term** — 中文释义 (Ch 1, Ch 5)"
const glossary = [];
for (const raw of read('glossary.md').split(/\r?\n/)) {
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
  const zh = term; // 英文 term 无中文对照单独字段；释义首词即中文
  glossary.push({ term, zh, def: cleanInline(def), chapters: chRefs });
}

// patterns / cheatsheet：整份按二级标题切
function docSections(name) {
  return splitSections(read(name)).map((s) => ({ heading: s.heading, lines: s.lines }));
}

const out = {
  generated: new Date().toISOString().slice(0, 10),
  chapters,
  glossary,
  patterns: docSections('patterns.md'),
  cheatsheet: docSections('cheatsheet.md'),
};

writeFileSync(outFile, JSON.stringify(out, null, 1), 'utf8');
console.log(`已生成 ${outFile}`);
console.log(`  章节 ${chapters.length}、术语 ${glossary.length}、patterns ${out.patterns.length}、cheatsheet ${out.cheatsheet.length}`);
