// 课堂活动 · 历史与成绩
//   教师：能看每场的完整积分榜（赛后复盘 / 讲评）
//   学生：只看得到自己的成绩与名次（沿用「学生端不公示别人名次」的口径；大屏由投屏窗口承担）
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import {
  fetchParticipants,
  fetchRecentSessions,
  fetchSessionState,
  type LiveParticipant,
  type LiveSession,
  type LiveStateRow,
} from '../lib/live';

export default function LiveHistory() {
  const { authUser, isTeacher } = useStore();
  const uid = authUser?.id ?? '';

  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [parts, setParts] = useState<LiveParticipant[]>([]);
  const [rows, setRows] = useState<LiveStateRow[]>([]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await fetchRecentSessions(10);
        if (alive) setSessions(list);
      } catch (e) {
        if (alive) setMsg((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const open = useCallback(async (id: string) => {
    setOpenId(id);
    setMsg('');
    try {
      setParts(await fetchParticipants(id));
      setRows(await fetchSessionState(id));
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  if (loading) return <div className="card"><p className="muted">正在读取历史…</p></div>;

  if (sessions.length === 0) {
    return (
      <div className="card">
        <h2>历史与成绩</h2>
        <p className="muted">还没有进行过课堂活动。</p>
      </div>
    );
  }

  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.user_id, (totals.get(r.user_id) ?? 0) + r.points);
  const board = parts
    .map((p) => ({ uid: p.user_id, name: p.name || p.user_id.slice(0, 6), points: totals.get(p.user_id) ?? 0 }))
    .sort((a, b) => b.points - a.points);
  const myIdx = board.findIndex((b) => b.uid === uid);

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>历史与成绩</h2>
        <p className="muted" style={{ fontSize: '0.9rem' }}>最近 10 场课堂活动。点开可看该场积分榜。</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
          {sessions.map((s) => (
            <div key={s.id} className="row" style={{ alignItems: 'center', gap: '0.5rem' }}>
              <span>{s.title || '课堂活动'}</span>
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                {new Date(s.created_at).toLocaleString()}
              </span>
              {s.state === 'running' && <span className="badge">进行中</span>}
              <span className="spacer" />
              <button className="ghost" onClick={() => void open(s.id)}>
                {openId === s.id ? '已展开' : '查看成绩'}
              </button>
            </div>
          ))}
        </div>
        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
      </div>

      {openId && (
        <div className="card">
          {isTeacher ? (
            board.length === 0 ? (
              <p className="muted">这场没有成绩记录。</p>
            ) : (
              <table className="check-table" style={{ width: '100%' }}>
                <thead>
                  <tr><th>名次</th><th>姓名</th><th>积分</th></tr>
                </thead>
                <tbody>
                  {board.map((b, i) => (
                    <tr key={b.uid}>
                      <td>{i + 1}</td>
                      <td>{b.name}</td>
                      <td>{b.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : myIdx < 0 ? (
            <p className="muted">你在这场没有成绩记录。</p>
          ) : (
            <p>
              你在这场获得 <strong>{board[myIdx].points}</strong> 分，
              第 <strong>{myIdx + 1}</strong> 名（共 {board.length} 人）。
            </p>
          )}
        </div>
      )}
    </>
  );
}
