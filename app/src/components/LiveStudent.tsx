// 学生端：加入课堂活动 → 看题作答 → 等待结算 / 出局等待
//
// 口径（见《实时多人在线功能规划.md》第七节）：
//   · 判定全在服务端 RPC；这里只发原文、只收结果
//   · 限时内未提交 / 答错 = 本回合出局；答错后不能再提交（服务端只认第一条）
//   · 本轮结束前看不到正确答案（RLS：secrets 只在轮次 settled 后可读）
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import {
  fetchGroupState,
  fetchLatestRound,
  fetchMyAnswer,
  fetchParticipants,
  fetchRoundTerm,
  fetchRunningSession,
  fetchSessionState,
  joinSession,
  submitAnswer,
  subscribeLive,
  type LiveParticipant,
  type LiveRound,
  type LiveSession,
  type LiveStateRow,
} from '../lib/live';

export default function LiveStudent() {
  const { authUser, vocab } = useStore();
  const uid = authUser?.id ?? '';

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [participants, setParticipants] = useState<LiveParticipant[]>([]);
  const [joined, setJoined] = useState(false);
  const [round, setRound] = useState<LiveRound | null>(null);
  const [myAns, setMyAns] = useState<{ text: string; is_correct: boolean } | null>(null);
  const [myState, setMyState] = useState<LiveStateRow | null>(null);
  const [myPoints, setMyPoints] = useState(0);
  const [answerTerm, setAnswerTerm] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // 倒计时重绘
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(
    async (sid: string) => {
      const all = await fetchSessionState(sid);
      setMyPoints(all.filter((s) => s.user_id === uid).reduce((n, s) => n + s.points, 0));
      setParticipants(await fetchParticipants(sid));

      const r = await fetchLatestRound(sid);
      setRound(r);
      if (!r) {
        setMyAns(null);
        setMyState(null);
        setAnswerTerm(null);
        return;
      }
      setMyAns(await fetchMyAnswer(r.id, uid));
      const st = await fetchGroupState(sid, r.group_no);
      setMyState(st.find((s) => s.user_id === uid) ?? null);
      // 轮次结算后才读得到术语（RLS）；进行中返回 null
      const termId = await fetchRoundTerm(r.id);
      setAnswerTerm(termId ? (vocab.find((v) => v.id === termId)?.term ?? termId) : null);
    },
    [uid, vocab],
  );

  // 找进行中的课堂活动
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetchRunningSession();
        if (!alive) return;
        setSession(s);
        if (s) await refresh(s.id);
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // 实时订阅：收到信号就拉一次权威数据（掉线回来也一样）
  useEffect(() => {
    if (!session || !joined) return;
    return subscribeLive(session.id, (sig) => {
      if (sig.table !== 'live_participants') void refresh(session.id);
    });
  }, [session, joined, refresh]);

  const doJoin = async () => {
    if (!session) return;
    setBusy(true);
    setMsg('');
    try {
      await joinSession(session.id);
      setJoined(true);
      await refresh(session.id);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doSubmit = async () => {
    if (!round || !session) return;
    const text = input.trim();
    if (!text) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await submitAnswer(round.id, text, session.config?.grace_seconds ?? 1);
      setMyAns({ text, is_correct: res.is_correct });
      await refresh(session.id);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card"><p className="muted">正在查找课堂活动…</p></div>;

  if (!session) {
    return (
      <div className="card">
        <h2>课堂活动</h2>
        <p className="muted">当前没有进行中的课堂活动。老师发起后这里会出现加入按钮，首页也会有提示。</p>
      </div>
    );
  }

  const header = (
    <div className="card" style={{ marginBottom: '0.8rem' }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <strong>{session.title || '课堂活动'}</strong>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          已加入 {participants.length} 人{joined ? ` · 我的积分 ${myPoints}` : ''}
        </span>
      </div>
    </div>
  );

  if (!joined) {
    return (
      <>
        {header}
        <div className="card">
          <p>老师正在进行课堂活动，点击加入。</p>
          <button className="primary" onClick={doJoin} disabled={busy}>{busy ? '加入中…' : '加入课堂活动'}</button>
          {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
        </div>
      </>
    );
  }

  if (!round) {
    return (
      <>
        {header}
        <div className="card"><p>已加入，等待老师开始第一轮…</p></div>
      </>
    );
  }

  const remain = round.deadline_at
    ? Math.max(0, Math.ceil((new Date(round.deadline_at).getTime() - Date.now()) / 1000))
    : null;
  const outThisGroup = myState ? myState.out_round_no !== null : false;
  const groupFinished = (myState?.rank_in_group ?? null) !== null;

  // 回合已结束（抢答段结算过）：显示本回合名次与得分
  if (groupFinished) {
    return (
      <>
        {header}
        <div className="card center">
          <h3>第 {round.group_no} 回合结束</h3>
          <p>你获得第 <strong>{myState?.rank_in_group}</strong> 名</p>
          {answerTerm && <p>最后一题：<strong>{answerTerm}</strong></p>}
          <p className="muted">本场累计 {myPoints} 分 · 等待下一回合开始</p>
        </div>
      </>
    );
  }

  // 本回合已经开打之后才加入：本回合不参与（否则他一答对就会"存活"，对已淘汰的人不公平）
  if (!myState) {
    return (
      <>
        {header}
        <div className="card">
          <p>本回合已经开始，你将在<strong>下一回合</strong>参与。</p>
          <p className="muted" style={{ fontSize: '0.9rem' }}>老师开始下一回合时会自动把你加进来，先熟悉一下节奏就好。</p>
        </div>
      </>
    );
  }

  if (outThisGroup) {
    return (
      <>
        {header}
        <div className="card">
          <h3>本回合已出局</h3>
          <p className="muted">等待老师结束本回合；下一回合会重新开始，人人都有机会。</p>
          {answerTerm && <p>本轮正确答案：<strong>{answerTerm}</strong></p>}
          <p className="muted" style={{ fontSize: '0.9rem' }}>
            本回合你通过了 {myState?.survived_rounds ?? 0} 轮 · 本场累计 {myPoints} 分
          </p>
        </div>
      </>
    );
  }

  if (round.state === 'settled') {
    return (
      <>
        {header}
        <div className="card">
          <p className="muted">本轮已结束</p>
          {answerTerm && <p>正确答案：<strong>{answerTerm}</strong></p>}
          {myAns ? (
            <p style={{ color: myAns.is_correct ? 'var(--success)' : 'var(--danger)' }}>
              你的作答「{myAns.text}」{myAns.is_correct ? '正确，晋级' : '错误'}
            </p>
          ) : (
            <p className="muted">本轮你没有提交（限时内未提交视为出局）</p>
          )}
          <p className="muted">等待老师开始下一轮…</p>
        </div>
      </>
    );
  }

  // 本轮进行中
  if (myAns) {
    return (
      <>
        {header}
        <div className="card">
          <p className="muted">已提交，等待本轮结算</p>
          <p>你的作答：<strong>{myAns.text}</strong></p>
          <p style={{ color: myAns.is_correct ? 'var(--success)' : 'var(--danger)' }}>
            {myAns.is_correct ? '答对了' : '答错了 —— 本轮结束'}
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            本轮已作答 {round.answered_count} 人，其中答对 {round.correct_count} 人
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <span className="badge">{round.stage === 'buzz' ? '抢答段' : `第 ${round.group_no} 回合 · 第 ${round.round_no} 轮`}</span>
          <span className="spacer" />
          {remain !== null && <span className={`badge ${remain <= 10 ? 'danger' : 'success'}`}>剩余 {remain}s</span>}
        </div>
        <p style={{ margin: '0.7rem 0', lineHeight: 1.6 }}>{round.prompt}</p>
        <div className="row" style={{ gap: '0.5rem' }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doSubmit(); }}
            placeholder="输入英文术语…"
            autoComplete="off"
            autoFocus
            disabled={busy}
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="primary" onClick={() => void doSubmit()} disabled={busy || !input.trim()}>
            提交
          </button>
        </div>
        {round.stage === 'buzz' && (
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.4rem' }}>
            抢答段：第一个答对者胜出（几乎同时答对算并列）；答错即出局。
          </p>
        )}
        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
      </div>
    </>
  );
}
