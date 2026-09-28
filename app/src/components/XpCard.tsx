/**
 * XP / 等级卡片（首页）。
 *
 * 设计依据《练级与奖励体系方案》§3.3「展示位置」：
 *   首页今日目标卡下方 / 个人中心头部 ⇒ **等级徽章 + 经验条 + 今日已获 XP**；
 * §4.5.5 ⇒ 首页显示**本月 XP 增长**（本月的可操作目标）。
 *
 * ⚠ 只在**判定切换生效后**才渲染（`isServerCheckinEnabled()`）：
 *   切换前服务端 XP 恒为 0（起算日还没到），显示出来只会让学生困惑。
 *
 * ⚠ 徽章图标见方案第九节「上线前需要准备的视觉资产」，那里明确写了
 *   **「代码侧先用纯 CSS / emoji 也能跑通」** ⇒ 所以本组件不依赖图标设计，
 *   档位用**颜色 + 数字**表达（等级无上限，一个等级一个图标本就不可行）。
 */
import { useStore } from '../lib/store';
import { useXpSummary } from '../lib/xpSummary';
import { isServerCheckinEnabled } from '../lib/checkinMode';

/** 档位色：每 10 级一档（方案 §4.2 的「每 10 级 / 每 25 级 / 大节点」里的最细一档） */
function tierColor(level: number): string {
  if (level >= 50) return '#c084fc'; // 紫
  if (level >= 30) return '#f472b6'; // 粉
  if (level >= 20) return '#f59e0b'; // 金
  if (level >= 10) return '#94a3b8'; // 银
  return '#b45309';                  // 铜
}

function tierName(level: number): string {
  if (level >= 50) return '传说';
  if (level >= 30) return '大师';
  if (level >= 20) return '黄金';
  if (level >= 10) return '白银';
  return '青铜';
}

export default function XpCard() {
  const { authUser } = useStore();
  const enabled = isServerCheckinEnabled();
  const xp = useXpSummary(enabled);

  if (!enabled) return null;

  // 游客没有归属（服务端按 auth.uid() 记账），不显示等级卡片
  if (!authUser) return null;

  const { level, totalXp, todayXp, monthXp, loading, error } = xp;
  const color = tierColor(level.level);
  const pct = Math.round((level.progress || 0) * 100);

  return (
    <div className="card" style={{ marginBottom: '0.8rem' }}>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>等级</h2>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          {loading ? '载入中…' : error ? '暂时读不到' : `${totalXp} XP 累计`}
        </span>
      </div>

      <div className="row" style={{ alignItems: 'center', gap: '0.8rem' }}>
        {/* 等级徽章：档位色 + 数字 */}
        <div
          style={{
            minWidth: '4.2rem',
            padding: '0.35rem 0.6rem',
            borderRadius: '0.6rem',
            background: color,
            color: '#fff',
            textAlign: 'center',
            lineHeight: 1.15,
          }}
          title={`${tierName(level.level)}档`}
        >
          <div style={{ fontSize: '1.15rem', fontWeight: 700 }}>LV{level.level}</div>
          <div style={{ fontSize: '0.7rem', opacity: 0.9 }}>{tierName(level.level)}</div>
        </div>

        {/* 经验条 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              height: '0.7rem',
              borderRadius: '0.35rem',
              background: 'var(--border)',
              overflow: 'hidden',
            }}
          >
            <div style={{ width: `${pct}%`, height: '100%', background: color }} />
          </div>
          <div className="muted" style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
            {error
              ? `暂时无法读取经验值（${error}）`
              : `距 LV${level.level + 1} 还需 ${level.need} XP`}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: '0.6rem', fontSize: '0.9rem' }}>
        <span>今日 <strong>+{todayXp}</strong> XP</span>
        <span className="muted" style={{ margin: '0 0.4rem' }}>·</span>
        <span>本月 <strong>{monthXp}</strong> XP</span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          XP 由服务端计算，离线时也会补记
        </span>
      </div>
    </div>
  );
}
