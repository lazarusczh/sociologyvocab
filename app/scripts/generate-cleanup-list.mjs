// 生成「理论流派优先处理清单」：把过长的 theory 值（脏数据）按长度降序列出对应学者，
// 供教师在后台优先逐个编辑。不修改任何词库文件。
// 用法：在 app 目录下 node scripts/generate-cleanup-list.mjs
import { readFileSync, writeFileSync } from 'fs';

const items = JSON.parse(readFileSync('public/vocab-data.json', 'utf8'));
const scholars = items.filter((i) => i.type === 'scholar');

// 阈值：超过该长度的 theory 值视为「过长脏数据」（正常流派名一般 < 30 字符）
const THRESHOLD = 40;

// 按 theory 值聚合
const byTheory = new Map();
for (const s of scholars) {
  const t = (s.theory || '(空)').trim();
  if (t.length <= THRESHOLD) continue; // 只处理超长的
  if (!byTheory.has(t)) byTheory.set(t, []);
  byTheory.get(t).push(s.term);
}

const entries = [...byTheory.entries()].sort((a, b) => b[0].length - a[0].length);

const lines = [];
lines.push('# 理论流派优先处理清单（过长脏数据）');
lines.push('');
lines.push(`> 生成时间：${new Date().toISOString()}`);
lines.push(`> 筛选条件：学者 theory 值长度 > ${THRESHOLD} 字符（正常流派名一般 < 30 字符）`);
lines.push(`> 共 ${entries.length} 个过长值，涉及 ${entries.reduce((n, [, v]) => n + v.length, 0)} 条学者记录。`);
lines.push(`> 按长度从长到短排列：先改最长的，界面清理最快。`);
lines.push(`> 处理方式：教师后台「词条管理」→ 编辑该学者 → 理论流派多选里点选规范流派或新建，保存即可。`);
lines.push('');
lines.push('| # | 长度 | theory 当前值（过长） | 对应学者 |');
lines.push('|---|---|---|---|');
entries.forEach(([t, names], idx) => {
  const short = t.length > 80 ? t.slice(0, 80) + '…' : t;
  lines.push(`| ${idx + 1} | ${t.length} | \`${short}\` | ${names.join('、')} |`);
});
lines.push('');

// 附：所有出现过的脏值（去重样本），供快速判断哪些该并入哪个规范流派
const dirtyValues = entries.map(([t]) => t);
lines.push('## 附：过长值清单（完整原文）');
lines.push('');
dirtyValues.forEach((t, i) => {
  lines.push(`${i + 1}. (${t.length} 字) ${t}`);
});
lines.push('');

const outPath = '../theory-cleanup-list.md';
writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`清单已生成：${outPath}（${entries.length} 个过长值）`);
