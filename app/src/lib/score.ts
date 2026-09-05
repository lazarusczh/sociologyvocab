// 组卷器判分换算引擎（《组卷器方案.md》§2.1–2.4 / 数据模型初稿 §4）
// 档内线性插值；P1 按来源 gt 聚合（每道被选题 1 票）；P0 variant3 兜底基线；减量按满分比例缩放并向下取整

export interface GtComp { max: number; A: number; B: number; C: number; D: number; E: number }
export interface GtEntry { series: string; file?: string; components: Record<string, GtComp> }
export type GtList = GtEntry[];

export const SCHOOL_PCT: Record<string, number> = { 'A*': 90, A: 80, B: 70, C: 60, D: 50, E: 40, F: 30, G: 20, U: 0 };
export interface ThresholdRows { A: number; B: number; C: number; D: number; E: number }

/** 官方 gt 行 → 占满分百分比（取整到 0.1%，用于跨满分合成） */
const toPct = (v: number, max: number) => (max > 0 ? (v / max) * 100 : 0);

/** P1 聚合：来源题每道 1 票，逐级取百分比按题量加权，再乘当次满分后向下取整 */
export function deriveRowsP1(
  gt: GtList,
  sources: { series: string; comp: string; weight: number }[],
  fullRaw: number,
): ThresholdRows {
  const sum = { A: 0, B: 0, C: 0, D: 0, E: 0, w: 0 };
  for (const src of sources) {
    const entry = gt.find((g) => g.series === src.series);
    const c = entry?.components?.[src.comp];
    if (!c || c.max <= 0) continue;
    sum.A += toPct(c.A, c.max) * src.weight;
    sum.B += toPct(c.B, c.max) * src.weight;
    sum.C += toPct(c.C, c.max) * src.weight;
    sum.D += toPct(c.D, c.max) * src.weight;
    sum.E += toPct(c.E, c.max) * src.weight;
    sum.w += src.weight;
  }
  if (sum.w === 0) return { A: 0, B: 0, C: 0, D: 0, E: 0 };
  // sum.* 是百分比(0–100)的加权和 → 平均百分比 /100 × fullRaw
  const pick = (v: number) => Math.floor(((v / sum.w) / 100) * fullRaw);
  return { A: pick(sum.A), B: pick(sum.B), C: pick(sum.C), D: pick(sum.D), E: pick(sum.E) };
}

/** P0 基线：取官方某系列某 component（默认 variant3）行，按 作业满分/真题满分 等比例缩放、向下取整 */
export function scaleThresholds(comp: GtComp, targetFull: number): ThresholdRows {
  const f = (v: number) => Math.floor((v / comp.max) * targetFull);
  return { A: f(comp.A), B: f(comp.B), C: f(comp.C), D: f(comp.D), E: f(comp.E) };
}

export type RowSpec = { grade: string; cieRaw: number | null; schoolPct: number };

/** 生成换算表（A-level：A*…E + U，不显示 F/G；includeFG 供将来接入 IGCSE（有 F/G 等第）时启用，届时 F/G=E） */
export function buildRows(t: ThresholdRows, fullRaw: number, aStar: number | null, opts?: { includeFG?: boolean }): RowSpec[] {
  const rows: RowSpec[] = [
    { grade: 'A*', cieRaw: aStar, schoolPct: SCHOOL_PCT['A*'] },
    { grade: 'A', cieRaw: t.A, schoolPct: SCHOOL_PCT.A },
    { grade: 'B', cieRaw: t.B, schoolPct: SCHOOL_PCT.B },
    { grade: 'C', cieRaw: t.C, schoolPct: SCHOOL_PCT.C },
    { grade: 'D', cieRaw: t.D, schoolPct: SCHOOL_PCT.D },
    { grade: 'E', cieRaw: t.E, schoolPct: SCHOOL_PCT.E },
  ];
  if (opts?.includeFG) {
    rows.push({ grade: 'F', cieRaw: t.E, schoolPct: SCHOOL_PCT.F });
    rows.push({ grade: 'G', cieRaw: t.E, schoolPct: SCHOOL_PCT.G });
  }
  rows.push({ grade: 'U', cieRaw: 0, schoolPct: SCHOOL_PCT.U });
  void fullRaw;
  return rows;
}

/** 档内线性插值：E = S_lo + (S_hi−S_lo)/(R_hi−R_lo) × (raw−R_lo)，越界封顶/封底 */
export function bandLinear(raw: number, fullRaw: number, rows: RowSpec[]): number | null {
  if (raw <= 0) return 0;
  if (raw >= fullRaw) return 100;
  // 从高到低找 raw 落在哪个档：本档 = grade 的 cieRaw（含），上一档 = 更高级的 cieRaw（不含）
  const defined = rows.filter((r) => r.cieRaw != null);
  for (let i = 0; i < defined.length; i++) {
    const lo = defined[i];
    const hi = defined[i - 1]; // 更高一级
    const loRaw = lo.cieRaw as number;
    const hiRaw = hi ? (hi.cieRaw as number) : fullRaw;
    if (raw < loRaw) continue;
    if (raw >= hiRaw) continue;
    const hiPct = hi ? hi.schoolPct : 100;
    if (hiRaw === loRaw) return lo.schoolPct;
    return lo.schoolPct + ((hiPct - lo.schoolPct) / (hiRaw - loRaw)) * (raw - loRaw);
  }
  // raw 高于最高已定义档（如未填 A*）：落 A* 兜底区间，线性到 100
  const top = defined[0];
  if (top && raw >= (top.cieRaw as number)) {
    return top.schoolPct + ((100 - top.schoolPct) / (fullRaw - (top.cieRaw as number))) * (raw - (top.cieRaw as number));
  }
  return null;
}
