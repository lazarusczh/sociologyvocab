/**
 * 结算页的「本轮 +N XP」即时反馈（《练级与奖励体系方案》§3.3）。
 *
 * 取数与全部理由见 `lib/xpSummary.ts` 的 `useRoundXp`（为什么必须问服务端、
 * 为什么要先 flush 队列、为什么基线必须在本轮开始前取）。这里只管显示。
 *
 * `gain === null` 表示**还不知道**（切换未生效 / 基线没取到），此时不渲染。
 *
 * ⚠ `gain === 0` **要渲染**：那是真实信息 —— 可能撞上了每日上限 400，
 *   也可能是本轮所有事件在结算前已被心跳发走、分数早已计入基线。
 *   静默会把「一分没加到」变成看不见，而学生正盯着这里看反馈。
 */
export default function XpGain({ gain }: { gain: number | null }) {
  if (gain === null) return null;
  return (
    <p className="muted" style={{ fontSize: '0.9rem', margin: '0.4rem 0 0' }}>
      本轮 <strong style={{ color: 'var(--accent)' }}>+{gain} XP</strong>
    </p>
  );
}
