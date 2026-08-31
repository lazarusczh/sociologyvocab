// 一次性诊断脚本：生成词库 theory 字段的完整归并诊断报告（含"建议归并目标"）
// 用法：在 app 目录下 node scripts/analyze-theory-report.mjs
// 注意：本脚本只读取词库生成报告，不修改任何词库文件。
import { readFileSync, writeFileSync } from 'fs';

const items = JSON.parse(readFileSync('public/vocab-data.json', 'utf8'));
const scholars = items.filter((i) => i.type === 'scholar');

const byTheory = {};
for (const s of scholars) {
  const t = (s.theory || '(空)').trim();
  (byTheory[t] = byTheory[t] || []).push(s.term);
}

// ===== 建议归并映射（仅供人工决策参考，不自动写回词库）=====
// 键 = 当前 theory 值；值 = { suggest: 建议归并到哪个规范流派/观点, note: 说明 }
// 注意：较长的整段文本作为键太长，下方用 "prefixMatch" 数组做前缀匹配。
const MERGE_MAP = {
  // === ① 规范流派：保留，可归并变体 ===
  'Marxism': { suggest: 'Marxism', note: '规范流派，保留' },
  'Feminism': { suggest: 'Feminism', note: '规范流派；与下方 3 个 Feminism 变体合并' },
  'Statistics': { suggest: 'Statistics/数据来源', note: '多为机构/统计来源，建议单独归类，不参与三层匹配' },
  'Methodology': { suggest: 'Methodology(方法论)', note: '含 Weber/Lyotard，注意跨流派' },
  'Media Effects Models': { suggest: 'Media Effects Models', note: '规范流派，保留' },
  'Interactionism': { suggest: 'Interactionism', note: '规范流派，保留' },
  'Postmodernism': { suggest: 'Postmodernism', note: '与 "Late modernism & Postmodernism" 可合并' },
  'Functionalism': { suggest: 'Functionalism', note: '与下方 Functionalism 家族合并' },
  'Pluralism': { suggest: 'Pluralism', note: '规范流派，保留' },
  'Positivism': { suggest: 'Positivism', note: '规范流派，保留' },
  'Sociobiology': { suggest: 'Sociobiology', note: '规范流派，保留' },
  'Digital Optimism': { suggest: 'Digital Optimism', note: '规范流派（媒体章节），保留' },
  'Digital Pessimism': { suggest: 'Digital Pessimism', note: '规范流派（媒体章节），保留' },
  'Media Effects Models ': { suggest: 'Media Effects Models', note: '' },
  // === ② 流派变体：归并 ===
  'Feminism, Gender studies & Ethnic studies': { suggest: 'Feminism', note: '归并到 Feminism；其中 ethnic/gender 主题可选保留交叉标签' },
  'Feminism & Gender Studies': { suggest: 'Feminism', note: '归并到 Feminism' },
  'Feminism & Gender studies': { suggest: 'Feminism', note: '归并到 Feminism' },
  'Functionalism & New Right': { suggest: 'Functionalism', note: '归并到 Functionalism；New Right 可作子标签' },
  'Functionalism, New Right (neoliberalism) & Social Democratic theory': { suggest: 'Functionalism', note: '归并到 Functionalism；其中 Durkheim/Parsons 属经典功能主义' },
  'Conventional Marxism': { suggest: 'Marxism', note: '归并到 Marxism（或保留作子类）' },
  'Neo-Marxism': { suggest: 'Marxism', note: '归并到 Marxism（或保留作子类）' },
  'Late modernism & Postmodernism': { suggest: 'Postmodernism', note: '归并到 Postmodernism（或保留 "Late modernism"）' },
  'Other': { suggest: '（人工逐条归类）', note: '46 人待人工，含 Merton/Piaget/Bandura 等大牌' },
};

// 整段文本 → 建议提取的命名理论/观点（前缀匹配）
const PREFIX_SUGGEST = [
  ['Modernisation theory', 'Modernisation theory', '归入 Functionalism/现代化理论；Rostow 与 Parsons 的观点可抽为 "Modernisation theory"'],
  ['Assimilation theory', 'Assimilation theory', '归入 Functionalism（同化理论）；Gordon/Gans' ],
  ['Clash of civilisations', 'Clash of Civilisations', 'Huntington 的文明冲突论；归入 Functionalism/冲突视角均可' ],
  ['World System Theory', 'World System Theory', 'Wallerstein；归入 Marxism 或独立' ],
  ['Dependency Theory', 'Dependency Theory', 'Gunder Frank；归入 Marxism 或独立' ],
  ['Globalisation is a negative', 'Anti-globalisation', 'Seabrook；归入 Marxism（反全球化）' ],
  ['McDonaldisation', 'McDonaldisation', 'Ritzer；归入 Marxism/后现代' ],
  ['Risk society', 'Risk society', 'Beck；归入 Late modernism' ],
  ['Glocalisation', 'Glocalisation', 'Robertson；归入 Late modernism/文化全球化' ],
  ['Global citizens and regional links', 'Hyperglobaliser (Ohmae)', 'Ohmae；归入 Neo-liberalism/全球化乐观派' ],
  ["A neo-liberal 'Golden straitjacket'", 'Neo-liberalism (Friedman)', '归入 Neo-liberalism（新自由主义）' ],
  ['Capitalism has been an international', 'Marxism (Harvey)', 'Harvey；归入 Marxism' ],
  ['Global media presents a myth', 'Marxism (Fuchs)', 'Fuchs；归入 Marxism/媒体政治经济学' ],
  ['One negative consequence', 'McDonaldisation', 'Ritzer；重复 McDonaldisation' ],
  ['Positive on the effects of media', 'Network society (Castells)', 'Castells；归入 后现代/网络社会' ],
  ['Marxist approach to global migrations', 'Marxism (migration)', 'Castles & Kosack；归入 Marxism' ],
  ['Global processes are sweeping away', 'Globalisation (Martell)', 'Martell；归入 全球化批判' ],
  ['(overlap with media) New media', 'New media activism (Spencer-Thomas)', '归入 媒体/后现代' ],
  ['Globalisation is a process of de-traditionalisation', 'De-traditionalisation (Giddens)', 'Giddens；归入 Late modernism' ],
  ['Risk society and global green crime', 'Risk society (Beck)', 'Beck；归入 Late modernism' ],
  ['Emphasises the concept of', 'Glocalisation (Robertson)', 'Robertson；归入 文化全球化' ],
  ['Economic globalisation must also', 'Global feminism', '归入 Feminism' ],
  ['The feminisation of poverty', 'Feminisation of poverty', '归入 Feminism' ],
  ['Feminist perspectives on global crime', 'Feminist criminology', '归入 Feminism' ],
  ['The feminisation of survival', 'Feminisation of survival', 'Sassen；归入 Feminism' ],
  ['The Brain Drain', 'Brain drain', 'Koser；归入 全球化/移民' ],
  ['Harmful effect of immigration', 'Anti-immigration', 'Borjas；归入 新自由主义/移民批判' ],
  ['Benefits of immigration', 'Pro-immigration', '归入 移民研究' ],
  ['Social consequence of migration', 'Moral panic (Cohen)', 'Cohen；归入 Interactionism/标签理论' ],
  ['Under-employment', 'Under-employment', 'Hanlon & Vicino；归入 移民研究' ],
  ['Remittances: 80%', 'Remittances', 'World Bank；归入 移民研究/数据' ],
  ["Critiques of 'clash of civilisations'", 'Anti-Huntington', 'Freddy Gray；归入 批判' ],
  ['Cultural hybridity and global identity', 'Cultural hybridity', 'Bourn；归入 文化全球化' ],
  ['Global crime: While tourism', 'Global crime', 'Cohen & Kennedy；归入 全球化' ],
  ['Green crime: Classification', 'Green crime', 'Nigel South；归入 全球化/环境' ],
  ['The poor of the LEDCs', 'Anti-imperialism', 'Sankara；归入 Marxism' ],
  ['The Western approaches to development', 'Dependency critique', 'Galeano；归入 Marxism/依附论' ],
  ['Colonialism, TNCs and aids', 'Pro-globalisation', 'Goldthorpe；归入 新自由主义' ],
  ['Definitions of globalisation', 'Globalisation (Steger)', 'Steger；归入 全球化理论' ],
  ['American tribalism', 'Tribalism (Chua)', 'Chua；归入 政治学/族裔' ],
  ['Ethnic revitalisation', 'Ethnic revitalisation', 'Banks；归入 族裔研究' ],
  ['Universal standards for human rights', 'Cultural relativism', 'Haynes；归入 人权批判' ],
  ['Cultural relativity', 'Cultural relativism', 'Esteva；归入 文化相对主义' ],
  ["LEDCs' poverty are not of their own fault", 'Human capital theory', 'Sachs；归入 发展经济学' ],
  ['The traditional and the modern', 'Cultural synthesis', 'Chris Edwards；归入 文化全球化' ],
  ['(p. 512) Sandel argues', 'Populism critique (Sandel)', 'Sandel；归入 政治/全球化批判' ],
  ["'Aid can act as both carrot", 'US foreign aid', 'US CRS；归入 数据/机构' ],
  ["Ben Barber", 'McWorld (Barber)', 'Barber；归入 全球化批判' ],
  ["Refers to the World Bank", 'Unholy alliance (Chang)', 'Ha-Joon Chang；归入 Marxism/依附论' ],
  ["Barber (2003)", 'McWorld (Barber)', 'Barber；归入 全球化批判' ],
];

// 匹配某个 theory 值 → 返回建议
function suggestFor(theory) {
  if (MERGE_MAP[theory]) {
    const m = MERGE_MAP[theory];
    return `${m.suggest} —— ${m.note}`;
  }
  // 整段文本 → 前缀匹配
  for (const [prefix, name, note] of PREFIX_SUGGEST) {
    if (theory.startsWith(prefix)) {
      return `【提取】${name} —— ${note}`;
    }
  }
  return '（需人工判断）';
}

const keys = Object.keys(byTheory).sort((a, b) => byTheory[b].length - byTheory[a].length);

// 统计各类别数量
let extractCnt = 0, variantCnt = 0, otherCnt = byTheory['Other'] ? byTheory['Other'].length : 0;
for (const k of keys) {
  const sug = suggestFor(k);
  if (sug.includes('【提取】')) extractCnt++;
  else if (MERGE_MAP[k] && MERGE_MAP[k].suggest !== k && !k.includes('整段')) variantCnt++;
}

const lines = [];
lines.push(`# 词库 theory 字段诊断与归并建议报告`);
lines.push(``);
lines.push(`> 本报告仅提供归并**建议**，供人工决策参考；不修改任何词库文件。`);
lines.push(``);
lines.push(`- 生成时间：${new Date().toISOString()}`);
lines.push(`- 学者/机构总数：${scholars.length}`);
lines.push(`- 不同 theory 值总数：${keys.length}`);
lines.push(`- "Other" 兜底：${otherCnt} 人（需人工逐条归类）`);
lines.push(`- 疑似整段文本（需提取命名观点）：${extractCnt} 个值`);
lines.push(`- 流派变体（建议归并）：${variantCnt} 个值`);
lines.push(``);
lines.push(`## 建议归并策略（你的倾向）`);
lines.push(`1. **变体**（如 Feminism 4 变体、Functionalism 3 变体）→ 归并到规范流派名。`);
lines.push(`2. **整段文本**（如 Modernisation theory、Dependency Theory）→ 提取为「命名理论/观点」作为 views，**而非**当流派。其中你提到 Modernisation theory 实际更接近 Functionalism —— 建议把"现代化理论"这类归入 Functionalism 大流派，具体以你确认为准。`);
lines.push(`3. **Other** → 逐条人工归类。`);
lines.push(``);
lines.push(`## 全量清单（按人数降序）`);
lines.push(``);

keys.forEach((k, i) => {
  const n = byTheory[k].length;
  const sug = suggestFor(k);
  lines.push(`### ${i + 1}. ${n} 人`);
  lines.push(`- **当前值**：\`${k}\``);
  lines.push(`- **建议**：${sug}`);
  lines.push(`- 学者：${byTheory[k].join('、')}`);
  lines.push(``);
});

const outPath = '../theory-diagnostic-report.md';
writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`报告已生成：${outPath}（共 ${keys.length} 个流派值，含建议归并目标）`);
