/**
 * 等级奖励面板：点等级条右端的「下一等级」标签弹出，回答"到了这一级能拿什么"。
 *
 * 教师 2026-10-10 提出：首页等级条**开端是 LV1**，末尾该有一个**对称的 LV2**，
 * 点它就能知道下一级有什么奖励。
 *
 * ⚠ 奖励**只列真正会发的东西**。规则在 `lib/levelRewards.ts`，那里写明了它与
 *   服务端 `grant_pending_cards()`（`db-migration-cards-v2.sql`）的对齐关系 ——
 *   界面上的错误承诺比"不显示"更糟（学生会照着它规划）。
 *
 * ⚠ 单独成文件的两个理由：① 可**脱离 store / supabase 单独挂载验证**（`XpCard` 依赖
 *   登录态，没有 `authUser` 时直接返回 null，实验页里根本挂不起来）；② 教师端以后
 *   若要展示某个学生的下一级奖励，可以复用同一块面板。
 *
 * ⚠ 复用打卡庆祝那套 `.celebration-overlay` / `.celebration-modal`
 *   （`Crossword.tsx` 已有"借它当确认框"的先例）⇒ 点遮罩关闭、点面板本身不关。
 */
import { xpForLevel } from '../lib/xpLevel';
import { levelRewards, nextRewardLevel, REWARD_LABEL, REWARD_HINT } from '../lib/levelRewards';

export default function LevelRewardsPanel({
  level,
  totalXp,
  onClose,
}: {
  level: number;
  /** 当前累计 XP（用来算"你还差多少"） */
  totalXp: number;
  onClose: () => void;
}) {
  const rewards = levelRewards(level);
  const need = xpForLevel(level);
  const gap = Math.max(0, need - totalXp);
  // 本级没有奖励时，告诉学生"最近的一次在哪儿"—— 这是 LV10 之前所有人都会看到的画面
  const upcoming = nextRewardLevel(level + 1);
  const upcomingRewards = levelRewards(upcoming);
  const upcomingGap = Math.max(0, xpForLevel(upcoming) - totalXp);

  return (
    <div className="celebration-overlay" onClick={onClose}>
      <div
        className="celebration-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`LV${level} 的奖励`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="celebration-title">LV{level}</div>
        <div className="celebration-desc">
          累计 {need} XP 达成{gap > 0 ? ` · 你还差 ${gap} XP` : ''}
        </div>

        {rewards.length > 0 ? (
          <>
            <div className="muted" style={{ fontSize: '0.85rem' }}>到达本级可得</div>
            <ul className="lv-rewards">
              {rewards.map((r) => (
                <li key={r.kind}>
                  <span className="badge success">{REWARD_LABEL[r.kind]} ×{r.count}</span>
                  <span className="muted" style={{ fontSize: '0.82rem' }}>{REWARD_HINT[r.kind]}</span>
                </li>
              ))}
            </ul>
            <div className="muted" style={{ fontSize: '0.78rem' }}>
              {rewards.map((r) => r.reason).join('；')}
            </div>
          </>
        ) : (
          <>
            <div className="celebration-desc">这一级没有里程碑奖励。</div>
            {upcomingRewards.length > 0 && (
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                最近的一次在 <strong>LV{upcoming}</strong>：
                {upcomingRewards.map((r) => `${REWARD_LABEL[r.kind]} ×${r.count}`).join('、')}
                {upcomingGap > 0 ? `（还需 ${upcomingGap} XP）` : ''}
              </div>
            )}
          </>
        )}

        <button className="primary" onClick={onClose}>知道了</button>
      </div>
    </div>
  );
}
