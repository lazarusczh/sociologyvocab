// 等级曲线（纯计算，**不依赖网络与 Supabase**）。
//
// 单独成文件的原因有两个：
//   ① 可独立测试 —— 不必连带加载 supabase 客户端；
//   ② 可被其它模块直接复用（如教师端看板展示学生等级），不引入副作用。
//
// 曲线见《练级与奖励体系方案.md》§3.1（2026-09-22 重设，原「LV12 封顶」已废止）：
//
//   每级递增 `120 + 10×(n-1)`，**等级不设上限**
//   （不设上限是为了省掉将来「有人练满级了要不要再加级」的维护负担）。
//
//   累计：XP(LV k) = 120(k-1) + 10(k-1)(k-2)/2 = 5k² + 105k − 110
//   反解：k = (√(13225 + 20x) − 105) / 10
//
// 对账（与方案表格一致）：LV2 = 120、LV5 = 540、LV10 = 1440、
//   LV20 = 3990、LV30 = 7540、LV40 = 12090、LV50 = 17640。

/** LV1→LV2 所需 XP。**这是「升级手感」的唯一开关**：
 *  调到 100 则普通学生（实测日均 113 XP）基本每天必升一级；
 *  调到 150 则每天差一点、隔天升。改它只影响这一处常量，不必动公式。 */
export const LEVEL_BASE = 120;

/** 每升一级，所需 XP 的递增量。 */
export const LEVEL_STEP = 10;

/** 达到该等级所需的累计 XP。 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  const n = level - 1;
  return LEVEL_BASE * n + (LEVEL_STEP * n * (n - 1)) / 2;
}

export interface LevelInfo {
  level: number;
  into: number;     // 本级已积累的 XP
  need: number;     // 升到下一级还需多少
  progress: number; // 0~1，经验条填充比例
}

/** 由累计 XP 反解等级与进度。 */
export function levelOf(totalXp: number): LevelInfo {
  const x = Math.max(0, Math.floor(totalXp || 0));
  // 反解公式只给近似值（浮点误差），再用公式回验各修正一步，避免边界处差一级
  let level = Math.max(1, Math.floor((Math.sqrt(13225 + 20 * x) - 105) / 10));
  while (xpForLevel(level + 1) <= x) level++;
  while (level > 1 && xpForLevel(level) > x) level--;
  const at = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = next - at;
  const into = x - at;
  return { level, into, need: next - x, progress: span > 0 ? into / span : 0 };
}
