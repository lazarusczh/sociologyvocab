/**
 * 「某一等级能拿什么奖励」—— **纯计算，不依赖网络**（与 `xpLevel.ts` 同级的存在理由：
 * 可独立测试、可被教师端复用，不引入 supabase 副作用）。
 *
 * ⚠⚠ **唯一权威是服务端真正发放它的那段 SQL**：
 *   `db-migration-cards-v2.sql` → `grant_pending_cards()` 里的 B1 / B2 / B3：
 *     B1. 每 10 级：`case when (lv/10) % 2 = 1 then 'makeup' else 'bonus' end`
 *         ⇒ LV10 补签卡 → LV20 加分卡 → LV30 补签卡 …（交替）
 *     B2. 每 25 级：加分卡 ×1（**叠加**在上面那档之上）
 *     B3. 大节点 LV50 / LV100 / LV200：**加分卡 ×2**
 *   本文件是把那三段**翻译成可枚举的清单**（那段 SQL 只对"已达成的等级"发卡，
 *   产不出"任意等级应发什么"）。**改任一边，另一边必须同步。**
 *   ⚠ 界面上的错误承诺比"不显示"更糟 —— 学生会照着它规划。
 *
 * ⚠ 方案 §4.2 的表格里大节点还写了「特殊徽章」，**这里故意不列**：
 *   徽章只有一行规则描述、没有任何资产（§4.2 自己标着"前置依赖：特殊徽章需要图标设计"），
 *   数据库那边也不发任何东西。列出来就是空头承诺。
 *
 * ⚠ 对账口径（2026-10-10 逐条对过 SQL）：LV10 = 补签卡 ×1；LV20 = 加分卡 ×1；
 *   LV25 = 加分卡 ×1；**LV50 = 补签卡 ×1 + 加分卡 ×3**（每 10 级那档给补签卡、
 *   每 25 级 +1、大节点 +2）—— 方案 §4.2 表格里"LV50 拿 2 张加分卡"是**近似说法**，
 *   实际以 SQL 为准（本函数按 SQL 算）。
 */

export type RewardKind = 'makeup' | 'bonus';

export interface LevelReward {
  kind: RewardKind;
  count: number;
  /** 为什么给（面板上一行小字说明） */
  reason: string;
}

export const REWARD_LABEL: Record<RewardKind, string> = {
  makeup: '补签卡',
  bonus: '加分卡',
};

/** 卡的作用（口径照抄：补签卡见方案 §4.3，加分卡见 §4.2.1） */
export const REWARD_HINT: Record<RewardKind, string> = {
  makeup: '补上漏签的一天 · 不过期、可累积',
  bonus: '对本站已完成的作业/测验再申请一次加分 · 与订正加分叠加，满分封顶',
};

/** 该等级的里程碑奖励；**大多数等级是空的**（只在 10 / 25 / 50 / 100 / 200 的整数倍上）。 */
export function levelRewards(level: number): LevelReward[] {
  if (!Number.isFinite(level) || level < 2) return [];
  const lv = Math.floor(level);
  const byKind = new Map<RewardKind, LevelReward>();
  const add = (kind: RewardKind, count: number, reason: string) => {
    const cur = byKind.get(kind);
    if (cur) {
      cur.count += count;
      cur.reason = `${cur.reason} + ${reason}`;
    } else {
      byKind.set(kind, { kind, count, reason });
    }
  };

  // B1 每 10 级：补签卡与加分卡交替
  if (lv % 10 === 0) {
    add((lv / 10) % 2 === 1 ? 'makeup' : 'bonus', 1, '每 10 级');
  }
  // B2 每 25 级：加分卡 ×1（叠加）
  if (lv % 25 === 0) add('bonus', 1, '每 25 级');
  // B3 大节点：加分卡 ×2
  if (lv === 50 || lv === 100 || lv === 200) add('bonus', 2, '大节点');

  return [...byKind.values()];
}

/**
 * 从 `fromLevel`（含）起**下一个有奖励的等级**。
 * 一定是 10 的整数倍（或 25 的整数倍）⇒ 最多 10 级之内必有一个，
 * 这里给 26 步的上限纯粹是防御性的（等级无上限，避免死循环）。
 */
export function nextRewardLevel(fromLevel: number): number {
  const start = Math.max(2, Math.floor(fromLevel));
  for (let lv = start; lv <= start + 26; lv++) {
    if (levelRewards(lv).length > 0) return lv;
  }
  return start;
}
