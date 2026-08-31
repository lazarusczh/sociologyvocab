import { useCallback, useEffect, useState } from 'react';

// 国家集：常规主要国家 + 数据极端的案例
const COUNTRIES = [
  { code: 'CHN', name: '中国' },
  { code: 'USA', name: '美国' },
  { code: 'GBR', name: '英国' },
  { code: 'JPN', name: '日本' },
  { code: 'IND', name: '印度' },
  { code: 'DEU', name: '德国' },
  { code: 'FRA', name: '法国' },
  { code: 'NGA', name: '尼日利亚' },
  { code: 'ZAF', name: '南非' },
  { code: 'BRA', name: '巴西' },
  { code: 'NER', name: '尼日尔' },
  { code: 'KOR', name: '韩国' },
];

// 指标配置：World Bank indicator code + 中文名 + 单位 + 社会学教学备注
interface IndicatorDef {
  code: string;
  label: string;
  unit: string;
  note: string;
  decimals: number; // 保留小数位
  source: 'wb' | 'static'; // wb=实时 World Bank；static=预抓取内置数据
  staticKey?: string;      // static 指标在 social-data.json 中的键
}

// World Bank 实时指标
const WB_INDICATORS: IndicatorDef[] = [
  {
    code: 'SP.DYN.CBRT.IN',
    label: '粗出生率',
    unit: '每千人活产数',
    note: '反映人口增长与生育水平，与社会结构、经济发展、女性教育相关。',
    decimals: 1,
    source: 'wb',
  },
  {
    code: 'SE.ADT.LITR.ZS',
    label: '成人识字率',
    unit: '%',
    note: '反映教育普及程度，与性别平等、现代化、劳动力素质相关。',
    decimals: 1,
    source: 'wb',
  },
  {
    code: 'SI.POV.GINI',
    label: '基尼系数',
    unit: '0–100（越高越不平等）',
    note: '衡量收入不平等，社会学中常用于分析社会分层与阶级结构。',
    decimals: 0,
    source: 'wb',
  },
  {
    code: 'SI.POV.DDAY',
    label: '极端贫困率',
    unit: '%（日均生活 2.15 美元以下）',
    note: '衡量绝对贫困，与全球不平等、发展议题直接相关。',
    decimals: 1,
    source: 'wb',
  },
];

// 预抓取指标（数据内置在 /social-data.json，由 scripts/fetch-social-data.mjs 生成）
const STATIC_INDICATORS: IndicatorDef[] = [
  {
    code: 'marriage',
    label: '粗结婚率',
    unit: '每千人结婚数',
    note: '反映婚姻制度与家庭变迁；数据源 Our World in Data（OECD 家庭数据库）。',
    decimals: 1,
    source: 'static',
    staticKey: 'marriage',
  },
  {
    code: 'divorce',
    label: '粗离婚率',
    unit: '每千人离婚数',
    note: '反映家庭稳定性与婚姻变迁趋势；数据源 Our World in Data（OECD 家庭数据库）。',
    decimals: 2,
    source: 'static',
    staticKey: 'divorce',
  },
];

const INDICATORS: IndicatorDef[] = [...WB_INDICATORS, ...STATIC_INDICATORS];

// 国家 → 数值 + 年份（可为 null = 无数据）
interface Datum {
  name: string;
  value: number | null;
  year: string | null; // 数据对应年份（论文引用用）
}

interface ChartData {
  def: IndicatorDef;
  data: Datum[];
}

// 拉取某个指标下所有国家的最新值（World Bank API，带年份）
async function fetchIndicator(def: IndicatorDef): Promise<ChartData> {
  const jobs = COUNTRIES.map(async ({ code, name }) => {
    try {
      // 走相对路径 /wb/*：本地由 Vite dev proxy 转发，部署后由 Worker 代理（避免浏览器直连被墙/CORS）
      const res = await fetch(
        `/wb/v2/country/${code}/indicator/${def.code}?format=json&per_page=1&mrnev=1`,
      );
      if (!res.ok) return { name, value: null, year: null } as Datum;
      const json = (await res.json()) as unknown;
      const arr = Array.isArray(json) && json.length > 1 ? (json[1] as { value?: number | null; date?: string }[]) : [];
      const row = arr[0];
      const v = row?.value;
      return {
        name,
        value: typeof v === 'number' ? v : null,
        year: row?.date ? String(row.date) : null,
      } as Datum;
    } catch {
      return { name, value: null, year: null } as Datum;
    }
  });
  const data = await Promise.all(jobs);
  return { def, data };
}

// 单个指标是否成功拿到任何数据（用于区分"网络失败"和"确实无数据"）
function hasAnyValue(data: Datum[]): boolean {
  return data.some((d) => d.value != null);
}

// 预抓取指标：读取内置 /social-data.json（新结构：{ latest: [...], series: {...} }）
async function fetchStaticIndicator(def: IndicatorDef): Promise<ChartData> {
  try {
    const res = await fetch('/social-data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      indicators?: Record<string, {
        latest?: { code: string; entity: string; year: number; value: number }[];
        series?: Record<string, { entity: string; series: { year: number; value: number }[] }>;
      }>;
    };
    const rows = json.indicators?.[def.staticKey ?? '']?.latest ?? [];
    const data = COUNTRIES.map(({ code, name }) => {
      const row = rows.find((r) => r.code === code);
      return {
        name,
        value: row ? row.value : null,
        year: row ? String(row.year) : null,
      } as Datum;
    });
    return { def, data };
  } catch {
    // 内置文件缺失/失败 → 全 null（页面会提示无数据）
    return { def, data: COUNTRIES.map(({ name }) => ({ name, value: null, year: null })) };
  }
}

// 拉取某国某指标的历史序列（World Bank date 范围），供趋势图
async function fetchSeries(code: string, def: IndicatorDef): Promise<{ year: string; value: number }[]> {
  try {
    const res = await fetch(
      `/wb/v2/country/${code}/indicator/${def.code}?format=json&per_page=60&date=1990:2024`,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as unknown;
    const arr = Array.isArray(json) && json.length > 1 ? (json[1] as { value?: number | null; date?: string }[]) : [];
    return arr
      .filter((x) => typeof x.value === 'number' && x.date)
      .map((x) => ({ year: String(x.date), value: x.value as number }))
      .sort((a, b) => Number(a.year) - Number(b.year)); // 年份升序：左旧右新
  } catch {
    return [];
  }
}

// 预抓取指标的历史序列（从内置 /social-data.json 读，无逐年数据则返回空）
async function fetchStaticSeries(code: string, def: IndicatorDef): Promise<{ year: string; value: number }[]> {
  try {
    const res = await fetch('/social-data.json', { cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      indicators?: Record<string, { series?: Record<string, { series?: { year: number; value: number }[] }> }>;
    };
    const series = json.indicators?.[def.staticKey ?? '']?.series?.[code]?.series ?? [];
    return series
      .filter((p) => Number.isFinite(p.value))
      .map((p) => ({ year: String(p.year), value: p.value }))
      .sort((a, b) => Number(a.year) - Number(b.year));
  } catch {
    return [];
  }
}

// 折线图尺寸
const W = 560;
const H = 220;
const PAD_L = 46;
const PAD_R = 14;
const PAD_T = 20;
const PAD_B = 30;

// 加载全部指标（wb 实时 + static 内置）
async function loadAllIndicators(): Promise<ChartData[]> {
  return Promise.all(
    INDICATORS.map((def) => (def.source === 'static' ? fetchStaticIndicator(def) : fetchIndicator(def))),
  );
}

export default function DataBoard() {
  const [charts, setCharts] = useState<ChartData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<'compare' | 'trend'>('compare');
  const [trendCountry, setTrendCountry] = useState('CHN');
  const [trendData, setTrendData] = useState<{ def: IndicatorDef; series: { year: string; value: number }[] }[]>([]);
  const [trendLoading, setTrendLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const results = await loadAllIndicators();
        if (cancelled) return;
        setCharts(results);
      } catch {
        if (!cancelled) setError('数据加载失败，请检查网络后重试。');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const reload = useCallback(() => {
    setError('');
    setLoading(true);
    (async () => {
      try {
        const results = await loadAllIndicators();
        setCharts(results);
      } catch {
        setError('数据加载失败，请检查网络后重试。');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 加载某国的历史趋势（wb 实时 + static 内置）
  const loadTrend = useCallback(async (code: string) => {
    setTrendLoading(true);
    setError('');
    try {
      const results = await Promise.all(
        INDICATORS.map(async (def) => ({
          def,
          series: def.source === 'static' ? await fetchStaticSeries(code, def) : await fetchSeries(code, def),
        })),
      );
      setTrendData(results);
    } catch {
      setError('趋势数据加载失败。');
    } finally {
      setTrendLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === 'trend') loadTrend(trendCountry);
  }, [view, trendCountry, loadTrend]);

  const anyData = charts.some((c) => hasAnyValue(c.data));

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.4rem' }}>
        <h3 style={{ margin: 0 }}>各国社会数据看板</h3>
        <span className="spacer" />
        <div className="tag-filter">
          <button className={view === 'compare' ? 'active' : ''} onClick={() => setView('compare')}>国家对比</button>
          <button className={view === 'trend' ? 'active' : ''} onClick={() => setView('trend')}>历史趋势</button>
        </div>
        {view === 'compare' && (loading ? (
          <span className="muted" style={{ fontSize: '0.85rem' }}>加载中…</span>
        ) : (
          <button className="ghost" onClick={reload}>刷新数据</button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        数据来源：世界银行开放数据 API。年份为各指标最新可得年份；用于课堂数据论据与论文引用参考。
      </p>
      {error && <p className="gate-error" style={{ marginTop: '0.5rem' }}>{error}</p>}

      {view === 'compare' && (
        <>
          {!loading && !anyData && charts.length > 0 && (
            <div className="card" style={{ marginTop: '0.6rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
              <p style={{ fontSize: '0.85rem', margin: 0 }}>
                暂时无法获取世界银行数据。可能是当前网络无法访问 api.worldbank.org（需科学上网），或接口暂时不可用。
                请检查网络后点「刷新数据」重试。
              </p>
            </div>
          )}

          {!loading && charts.map((c) => (
            <div key={c.def.code} style={{ marginTop: '1.2rem' }}>
              <div className="row" style={{ alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600, fontSize: '1rem' }}>{c.def.label}</span>
                <span className="muted" style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>（{c.def.unit}）</span>
              </div>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.2rem' }}>{c.def.note}</p>
              <BarChart data={c.data} decimals={c.def.decimals} />
            </div>
          ))}
        </>
      )}

      {view === 'trend' && (
        <>
          <div className="row" style={{ marginTop: '0.6rem', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>选择国家：</span>
            <select value={trendCountry} onChange={(e) => setTrendCountry(e.target.value)} style={{ maxWidth: '12rem' }}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            {trendLoading && <span className="muted" style={{ fontSize: '0.85rem' }}>加载中…</span>}
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.3rem' }}>
            展示 {COUNTRIES.find((c) => c.code === trendCountry)?.name} 各项指标的历史变化
            （出生率/识字率/基尼/贫困率：1990–2024；结婚/离婚率：依数据源覆盖年份）。
          </p>
          {!trendLoading && trendData.map(({ def, series }) => (
            <div key={def.code} style={{ marginTop: '1.2rem' }}>
              <div className="row" style={{ alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600, fontSize: '1rem' }}>{def.label}</span>
                <span className="muted" style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>（{def.unit}）</span>
              </div>
              <LineChart series={series} decimals={def.decimals} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// SVG 柱状图：每国一根柱子，无数据时显示占位
function BarChart({ data, decimals }: { data: Datum[]; decimals: number }) {
  const hasAny = data.some((d) => d.value != null);
  if (!hasAny) {
    return <p className="muted" style={{ fontSize: '0.85rem', padding: '1rem 0' }}>暂无可展示数据。</p>;
  }

  const values = data.map((d) => d.value ?? 0);
  const max = Math.max(...values, 1) * 1.15; // 顶部留白
  const n = data.length;
  const slot = (W - PAD_L - PAD_R) / n;
  const barW = Math.max(14, slot * 0.55);

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {/* 网格线 */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = PAD_T + (H - PAD_T - PAD_B) * (1 - t);
          return (
            <g key={t}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="var(--border)" strokeDasharray="3 3" />
              <text x={PAD_L - 6} y={y + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                {(max * t).toFixed(decimals)}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const cx = PAD_L + slot * i + slot / 2;
          const h = d.value != null ? ((d.value / max) * (H - PAD_T - PAD_B)) : 0;
          const y = H - PAD_B - h;
          return (
            <g key={d.name}>
              {d.value != null ? (
                <>
                  <rect x={cx - barW / 2} y={y} width={barW} height={h} rx={3} fill="var(--accent)" opacity={0.85}>
                    <title>{`${d.name}：${d.value.toFixed(decimals)}（${d.year ?? '—'}）`}</title>
                  </rect>
                  <text x={cx} y={y - 5} textAnchor="middle" fontSize="10" fill="var(--text)">
                    {d.value.toFixed(decimals)}
                  </text>
                </>
              ) : (
                <text x={cx} y={H - PAD_B - 8} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                  无
                </text>
              )}
              <text x={cx} y={H - PAD_B + 14} textAnchor="middle" fontSize="10" fill="var(--text)">
                {d.name}
              </text>
              <text x={cx} y={H - PAD_B + 27} textAnchor="middle" fontSize="9" fill="var(--text-muted)">
                {d.year ?? ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// SVG 折线图：某国某指标历史趋势
function LineChart({ series, decimals }: { series: { year: string; value: number }[]; decimals: number }) {
  if (series.length === 0) {
    return <p className="muted" style={{ fontSize: '0.85rem', padding: '0.6rem 0' }}>该国家此指标暂无历史数据。</p>;
  }
  const W2 = W, H2 = H;
  const PADL = PAD_L, PADR = PAD_R, PADT = PAD_T, PADB = PAD_B + 10;
  const maxV = Math.max(...series.map((p) => p.value), 1) * 1.15;
  const minV = Math.min(...series.map((p) => p.value), 0);
  const range = Math.max(maxV - minV, 1);
  const plotW = W2 - PADL - PADR;
  const plotH = H2 - PADT - PADB;
  const x = (y: string) => {
    const first = Number(series[0].year);
    const last = Number(series[series.length - 1].year);
    const t = last === first ? 0 : (Number(y) - first) / (last - first);
    return PADL + t * plotW;
  };
  const yPos = (v: number) => PADT + plotH * (1 - (v - minV) / range);

  const pts = series.map((p) => `${x(p.year)},${yPos(p.value)}`).join(' ');

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W2} height={H2} viewBox={`0 0 ${W2} ${H2}`} style={{ display: 'block' }}>
        {/* 网格线 */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const yy = PADT + plotH * (1 - t);
          return (
            <g key={t}>
              <line x1={PADL} y1={yy} x2={W2 - PADR} y2={yy} stroke="var(--border)" strokeDasharray="3 3" />
              <text x={PADL - 6} y={yy + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">
                {(minV + range * t).toFixed(decimals)}
              </text>
            </g>
          );
        })}
        <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={2} />
        {series.map((p) => (
          <g key={p.year}>
            <circle cx={x(p.year)} cy={yPos(p.value)} r={2.5} fill="var(--accent)">
              <title>{`${p.year}：${p.value.toFixed(decimals)}`}</title>
            </circle>
          </g>
        ))}
        {/* 首尾年份标注 */}
        <text x={x(series[0].year)} y={H2 - PADB + 16} textAnchor="middle" fontSize="9" fill="var(--text-muted)">
          {series[0].year}
        </text>
        <text x={x(series[series.length - 1].year)} y={H2 - PADB + 16} textAnchor="middle" fontSize="9" fill="var(--text-muted)">
          {series[series.length - 1].year}
        </text>
      </svg>
    </div>
  );
}
