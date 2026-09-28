// 投屏窗口（由控制台的「打开投屏窗口」按钮以 `?board=<sessionId>` 打开）
//
// 只渲染大屏、没有导航；用当前登录会话（教师）读全量数据。
//   · 拼写竞赛 → 存活表 + 总积分榜（复用 LiveBoard 的大字号模式）
//   · 口头速答 → **收题后**才匿名展示全部答案（随机顺序）
//               作答中只显示"已收到 N 份"，避免先交的人把答案摆在后来者面前
import { useCallback, useEffect, useRef, useState } from 'react';
import { shuffle } from '../lib/shuffle';
import {
  fetchGroupState,
  fetchLatestOralRound,
  fetchLatestRound,
  fetchOralAnswers,
  fetchParticipants,
  fetchSession,
  fetchSessionState,
  subscribeLive,
  type LiveOralAnswer,
  type LiveOralRound,
  type LiveParticipant,
  type LiveRound,
  type LiveSession,
  type LiveStateRow,
} from '../lib/live';
import LiveBoard from './LiveBoard';

export default function LiveBoardWindow({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [participants, setParticipants] = useState<LiveParticipant[]>([]);
  const [spellRound, setSpellRound] = useState<LiveRound | null>(null);
  const [groupState, setGroupState] = useState<LiveStateRow[]>([]);
  const [sessionState, setSessionState] = useState<LiveStateRow[]>([]);
  const [oralRound, setOralRound] = useState<LiveOralRound | null>(null);
  const [oralAnswers, setOralAnswers] = useState<LiveOralAnswer[]>([]);
  // 展示顺序：收题那一刻打乱一次后固定，避免每次刷新都重排（学生会看得眼花）
  const [ordered, setOrdered] = useState<LiveOralAnswer[]>([]);
  const shuffledFor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await fetchSession(sessionId);
    setSession(s);
    if (!s) return;
    setParticipants(await fetchParticipants(sessionId));
    if (s.kind === 'oral') {
      const r = await fetchLatestOralRound(sessionId);
      setOralRound(r);
      setOralAnswers(r ? await fetchOralAnswers(r.id) : []);
    } else {
      setSessionState(await fetchSessionState(sessionId));
      const r = await fetchLatestRound(sessionId);
      setSpellRound(r);
      setGroupState(r ? await fetchGroupState(sessionId, r.group_no) : []);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeLive(sessionId, () => void refresh()), [sessionId, refresh]);

  useEffect(() => {
    if (!oralRound || oralRound.state !== 'closed') {
      setOrdered([]);
      return;
    }
    if (shuffledFor.current === oralRound.id) return;   // 同一题只打乱一次
    shuffledFor.current = oralRound.id;
    setOrdered(shuffle([...oralAnswers]));
  }, [oralRound, oralAnswers]);

  const big = { padding: '2rem', minHeight: '100vh', boxSizing: 'border-box' } as const;
  const muted = { color: 'var(--c-muted, #6b7280)' };

  if (!session) {
    return <div style={big}><p style={{ fontSize: '1.4rem', ...muted }}>正在载入投屏数据…</p></div>;
  }

  if (session.kind === 'oral') {
    return (
      <div style={big}>
        <h1 style={{ fontSize: '2.2rem', margin: '0 0 1rem' }}>{session.title || '口头速答'}</h1>
        {!oralRound ? (
          <p style={{ fontSize: '1.8rem', ...muted }}>等待老师出题…</p>
        ) : oralRound.state === 'open' ? (
          <>
            <p style={{ fontSize: '2rem', margin: '0 0 0.5rem' }}>第 {oralRound.round_no} 题 · 作答中</p>
            <p style={{ fontSize: '1.5rem', ...muted }}>已收到 {oralAnswers.length} 份回答（收题后匿名展示）</p>
          </>
        ) : (
          <>
            <p style={{ fontSize: '1.8rem', margin: '0 0 1rem' }}>
              第 {oralRound.round_no} 题 · 全部回答（匿名，顺序随机）
            </p>
            {ordered.length === 0 ? (
              <p style={{ fontSize: '1.5rem', ...muted }}>这一题没有收到回答。</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.9rem' }}>
                {ordered.map((a) => (
                  <div key={a.id} className="card" style={{ margin: 0, padding: '0.9rem 1.3rem', fontSize: '1.6rem' }}>
                    {a.text}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <p style={{ marginTop: '2.5rem', fontSize: '1rem', ...muted }}>
          投屏视图 · 不显示姓名 · 在场 {participants.length} 人
        </p>
      </div>
    );
  }

  // 拼写竞赛（默认）
  return (
    <div style={big}>
      <h1 style={{ fontSize: '2.2rem', margin: '0 0 0.6rem' }}>{session.title || '课堂活动'}</h1>
      {spellRound && (
        <p style={{ fontSize: '1.5rem', margin: '0 0 1rem' }}>
          第 {spellRound.group_no} 回合 · 第 {spellRound.round_no} 轮
          {spellRound.state === 'open'
            ? ` · 进行中 · 已答 ${spellRound.answered_count} 人`
            : ' · 已结算'}
        </p>
      )}
      <LiveBoard participants={participants} groupState={groupState} sessionState={sessionState} big />
      <p style={{ marginTop: '2rem', fontSize: '1rem', ...muted }}>投屏视图 · 不显示作答内容</p>
    </div>
  );
}
