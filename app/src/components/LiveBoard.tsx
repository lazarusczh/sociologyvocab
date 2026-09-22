// 存活表 + 总积分榜：教师控制台与投屏窗口共用
//   存活表 = 当前回合的 live_spell_state（out_round_no 为空 = 仍存活）
//   总积分 = 整场 sessionState 按 user_id 汇总 points（跨回合累加）
// 只展示「姓名 / 状态 / 积分」，不含任何作答内容与答案。
import type { LiveParticipant, LiveStateRow } from '../lib/live';

interface Props {
  participants: LiveParticipant[];
  groupState: LiveStateRow[];
  sessionState: LiveStateRow[];
  big?: boolean;   // 投屏窗口用大字号
}

export default function LiveBoard({ participants, groupState, sessionState, big }: Props) {
  const totals = new Map<string, number>();
  for (const r of sessionState) totals.set(r.user_id, (totals.get(r.user_id) ?? 0) + r.points);

  const rows = participants.map((p) => {
    const cur = groupState.find((s) => s.user_id === p.user_id);
    return {
      user_id: p.user_id,
      name: p.name || p.user_id.slice(0, 6),
      alive: cur ? cur.out_round_no === null : true,
      outRound: cur?.out_round_no ?? null,
      rank: cur?.rank_in_group ?? null,
      survived: cur?.survived_rounds ?? 0,
      points: totals.get(p.user_id) ?? 0,
    };
  });
  // 存活优先，然后按积分降序
  rows.sort((a, b) => (a.alive === b.alive ? b.points - a.points : a.alive ? -1 : 1));

  if (rows.length === 0) {
    return <p className="muted">还没有学生加入。</p>;
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${big ? 180 : 130}px, 1fr))`,
        gap: big ? '0.7rem' : '0.5rem',
      }}
    >
      {rows.map((r) => (
        <div
          key={r.user_id}
          className="card"
          style={{
            margin: 0,
            padding: big ? '0.7rem 0.9rem' : '0.5rem 0.7rem',
            borderLeft: `4px solid ${r.alive ? 'var(--success, #16a34a)' : 'var(--c-muted, #9ca3af)'}`,
            opacity: r.alive ? 1 : 0.55,
          }}
        >
          <div className="row" style={{ alignItems: 'center', gap: '0.4rem' }}>
            <strong style={{ fontSize: big ? '1.15rem' : '0.95rem' }}>{r.name}</strong>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: big ? '1rem' : '0.8rem' }}>{r.points} 分</span>
          </div>
          <div className="muted" style={{ fontSize: big ? '0.95rem' : '0.75rem', marginTop: '0.2rem' }}>
            {r.alive
              ? (r.rank ? `第 ${r.rank} 名` : `存活 · 已过 ${r.survived} 轮`)
              : `已淘汰（第 ${r.outRound} 轮）`}
          </div>
        </div>
      ))}
    </div>
  );
}
