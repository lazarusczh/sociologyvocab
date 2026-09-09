// 从 ms-data.json 抽取「主题真题素材卡」，供蒸馏成知识站第 N 本（真题·评分视角）的章节语料。
// 用法：node scripts/skill-ms-extract.mjs <主题词:默认patriarchal> [评估词:默认evaluate]
// 试点：Paper 2（comp 21/22/23 = 家庭）里 Evaluate + patriarch 的 26 分题。
// 产物：scripts/ms-<主题词>-cards.json（临时素材卡，审阅后由教学化归纳成 chapters/*.md）
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = join(import.meta.dirname, '..', '..'); // 项目根
const topic = (process.argv[2] ?? 'patriarchal').toLowerCase();
const verb = (process.argv[3] ?? 'evaluate').toLowerCase();
const ms = JSON.parse(readFileSync(join(rootDir, 'ms-data.json'), 'utf8'));

const TERM = { m: 0, s: 1, w: 2 };
const termRank = (ses) => TERM[ses[0]] ?? 0;
const yearOf = (ses) => parseInt(ses.slice(1), 10) || 0;
const byWhen = (a, b) => yearOf(a) - yearOf(b) || termRank(a) - termRank(b);

// 清洗一行 ms 文本为要点（去 • / 编号 / 纯标记行）
const cleanLine = (ln) =>
  ln
    .replace(/^\s*[•\-\*]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

const cards = [];
for (const m of ms) {
  const comp = String(m.comp ?? '');
  if (!/^2/.test(comp)) continue; // 试点仅 Paper 2（家庭/21-23）
  for (const s of m.sections ?? []) {
    const text = (s.text ?? '').trim();
    if (!text) continue;
    if (!text.toLowerCase().includes(topic)) continue;
    if (!text.toLowerCase().includes(verb)) continue;
    const lines = text.split(/\r?\n/).map((x) => x.trim());
    const ic = lines.findIndex((x) => /indicative content/i.test(x));
    const qLines = (ic === -1 ? lines : lines.slice(0, ic)).filter(Boolean);
    const pts = (ic === -1 ? [] : lines.slice(ic + 1))
      .map(cleanLine)
      .filter((x) => x && !/^(total|max|award|level|mark|band|accept|reject|credit|do not|no mark|0|1|2)\b/i.test(x));
    // 压缩常见重复导语
    const points = [...new Set(pts)].slice(0, 14);
    cards.push({
      id: `${String(m.session).toUpperCase()} QP${comp} Q${s.q}`,
      q: qLines.join(' ').slice(0, 220),
      points,
    });
  }
}

cards.sort((a, b) => byWhen(a.id.slice(0, 3).toLowerCase(), b.id.slice(0, 3).toLowerCase()));
const outFile = join(import.meta.dirname, 'ms-' + topic + '-cards.json');
writeFileSync(outFile, JSON.stringify(cards, null, 1), 'utf8');
console.log(`主题词="${topic}" 评估词="${verb}"：命中 ${cards.length} 条 → ${outFile}`);
for (const c of cards) console.log(`  ${c.id}  ${c.q.slice(0, 90)}…（ms 要点 ${c.points.length} 条）`);
