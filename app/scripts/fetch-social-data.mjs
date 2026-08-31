// 预抓取社会数据（结婚率 / 离婚率）→ 生成 app/public/social-data.json
// 数据源：Our World in Data（源自 OECD Family Database 等）
// 用法：node scripts/fetch-social-data.mjs
// 生成文件含业务数据，已加入 .gitignore（不进公开仓库）；构建时由 Vite 复制进 dist
import { get } from 'https';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'public', 'social-data.json');

// 关注的 12 国（ISO3 代码）
const CODES = new Set(['CHN', 'USA', 'GBR', 'JPN', 'IND', 'DEU', 'FRA', 'NGA', 'ZAF', 'BRA', 'NER', 'KOR']);

const SOURCES = [
  { id: 'marriage', url: 'https://ourworldindata.org/grapher/marriage-rate-per-1000-inhabitants.csv', label: 'Crude marriage rate' },
  { id: 'divorce', url: 'https://ourworldindata.org/grapher/divorces-per-1000-people.csv', label: 'Crude divorce rate' },
];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`${url} → HTTP ${res.statusCode}`));
        return;
      }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function parseCsv(text) {
  // 简单 CSV 解析：按行、按逗号（数据无引号内逗号）
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const eIdx = header.indexOf('Entity');
  const cIdx = header.indexOf('Code');
  const yIdx = header.indexOf('Year');
  const vIdx = header.findIndex((h) => h !== 'Entity' && h !== 'Code' && h !== 'Year');
  if (eIdx < 0 || cIdx < 0 || yIdx < 0 || vIdx < 0) throw new Error('CSV header 不符: ' + header.join(','));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    rows.push({
      entity: p[eIdx]?.trim(),
      code: p[cIdx]?.trim(),
      year: Number(p[yIdx]),
      value: p[vIdx] !== undefined ? Number(p[vIdx]) : NaN,
    });
  }
  return rows.filter((r) => r.code && CODES.has(r.code) && Number.isFinite(r.value));
}

async function main() {
  const result = { fetchedAt: new Date().toISOString(), source: 'Our World in Data', indicators: {} };
  for (const s of SOURCES) {
    try {
      const text = await fetchText(s.url);
      const rows = parseCsv(text);
      // 每国完整历史序列（升序）+ 最新年份
      const byCode = new Map();
      for (const r of rows) {
        if (!byCode.has(r.code)) byCode.set(r.code, { entity: r.entity, points: [] });
        byCode.get(r.code).points.push({ year: r.year, value: r.value });
      }
      const entries = [...byCode.entries()].map(([code, v]) => {
        v.points.sort((a, b) => a.year - b.year); // 年份升序
        const last = v.points[v.points.length - 1];
        return {
          code,
          entity: v.entity,
          year: last.year,
          value: last.value,
          series: v.points,
        };
      }).sort((a, b) => a.code.localeCompare(b.code));
      result.indicators[s.id] = {
        latest: entries.map(({ code, entity, year, value }) => ({ code, entity, year, value })),
        series: Object.fromEntries(entries.map(({ code, entity, series }) => [code, { entity, series }])),
      };
      console.log(`${s.id}: ${entries.length} 国`);
    } catch (e) {
      console.error(`${s.id} 失败: ${e.message}`);
    }
  }
  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log(`已写入 ${OUT}`);
}

main();
