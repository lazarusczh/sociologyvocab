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

/**
 * 徽章色阶：**主色同系、由浅到深**，每 10 级升一档。
 *
 * ⚠ 「色阶」不是「档位命名」—— 徽章上除 `LV{n}` 外**不出现任何文字**（方案 §3.2：不做等级命名）。
 *   这里只是让老生的徽章在视觉上更有分量，等级数字始终是主要信息。
 *
 * ⚠ 引用 token、**不写死色值**：项目约定「组件全部引用变量，无硬编码色值」
 *   （`UI设计.md` 第二节 / `index.css` 顶部"设计令牌"）。写死不仅违反约定，
 *   而且不随深色模式切换。两组值分别在 `index.css` 的 `:root` 与深色块里定义。
 */
function levelColorVar(level: number): string {
  if (level >= 50) return 'var(--c-level-5)';
  if (level >= 30) return 'var(--c-level-4)';
  if (level >= 20) return 'var(--c-level-3)';
  if (level >= 10) return 'var(--c-level-2)';
  return 'var(--c-level-1)';
}

// ⚠ 不再提供档位「名称」。
//
// 我一度在这里写了「青铜 / 白银 / 黄金 / 大师 / 传说」，那是我自己造的 ——
// 《练级与奖励体系方案》§3.2 有一条明确的教师决定：
//   **不做等级命名**（不要"冒烟实验→田野调查"那套学科梗），一律只显示 `LV1` / `LV2` / …
// 理由是「命名需要反复打磨且容易变成负担」。
//
// ⇒ 方案要求的只是**徽章做成「档位 + 数字」**（§3.1 末：等级无上限，不能一个等级一个图标）。
//   所以色阶是"视觉分层"，**不是命名**；界面上除 `LV{n}` 外不出现任何等级名称。
//   ⇒ 教训：引入任何面向学生的新词汇前，先确认设计文档有没有定义过。

export default function XpCard() {
  const { authUser } = useStore();
  const enabled = isServerCheckinEnabled();
  const xp = useXpSummary(enabled);

  if (!enabled) return null;

  // 游客没有归属（服务端按 auth.uid() 记账），不显示等级卡片
  if (!authUser) return null;

  const { level, totalXp, todayXp, monthXp, loading, error } = xp;
  const color = levelColorVar(level.level);
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
        {/* 等级徽章：色阶 + 数字。**只有 `LV{n}`，没有任何等级名称**（方案 §3.2） */}
        <div
          style={{
            minWidth: '4.2rem',
            padding: '0.5rem 0.6rem',
            borderRadius: 'var(--r-xs)',
            background: color,
            // 彩色底上的固定前景 = 白字（不是主题色：用 --c-canvas 会在深色下变成深字）
            color: '#fff',
            textAlign: 'center',
            lineHeight: 1.1,
          }}
        >
          <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>LV{level.level}</div>
        </div>

        {/* 经验条 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              height: '0.7rem',
              borderRadius: 'var(--r-xs)',
              background: 'var(--c-track)',
              overflow: 'hidden',
            }}
          >
            <div style={{ width: `${pct}%`, height: '100%', background: color }} />
          </div>
          <div className="muted" style={{ fontSize: '0.8rem', marginTop: 'var(--sp-1)' }}>
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
