// 学生端：模拟调研（live_sessions.kind='sim'）
//
// 阶段（config.phase）：lobby 点名 → grouped 组内写题 → frozen 定稿 → answered 已作答 → reveal 揭晓
// 口径：
//   · 加入走 RPC sim_join_lobby（服务端决定分组；迟到者自动进人数最少的组）
//   · 只有作者能改自己的题，队友只读 —— 服务端 RPC 是权威，这里只是不给按钮
//   · 实时只当信号：收到变更就重拉权威数据，不在前端合并推断
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import SimQuestionCard, { SimQuestionView, emptyOptions } from './SimQuestionCard';
import {
  deleteQuestion,
  fetchGroups,
  fetchLatestPaper,
  fetchParticipants,
  fetchQuestions,
  fetchSimSession,
  groupLimitOf,
  joinLobby,
  phaseOf,
  saveQuestion,
  simErrorMessage,
  subscribeSim,
  type SimGroup,
  type SimOption,
  type SimPaper,
  type SimParticipant,
  type SimQType,
  type SimQuestion,
  type SimSession,
} from '../lib/sim';

const PHASE_LABEL: Record<string, string> = {
  lobby: '点名中',
  grouped: '写问卷',
  frozen: '问卷已定稿',
  answered: '访谈已完成',
  reveal: '揭晓中',
};

interface DraftCard {
  key: string;
  id: string | null;
  qtype: SimQType;
  stem: string;
  options: SimOption[];
}

export default function SimStudent({ sessionId }: { sessionId: string }) {
  const { authUser } = useStore();
  const uid = authUser?.id ?? '';

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SimSession | null>(null);
  const [participants, setParticipants] = useState<SimParticipant[]>([]);
  const [groups, setGroups] = useState<SimGroup[]>([]);
  const [questions, setQuestions] = useState<SimQuestion[]>([]);
  const [paper, setPaper] = useState<SimPaper | null>(null);
  const [joined, setJoined] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 本页新增的卡片：落库后仍保留本地编辑态（key 不变就不重挂载，不会丢焦点/丢字）
  const [drafts, setDrafts] = useState<DraftCard[]>([]);
  const syncedRef = useRef(false);

  const refresh = useCallback(async () => {
    const [s, ps] = await Promise.all([fetchSimSession(sessionId), fetchParticipants(sessionId)]);
    setSession(s);
    setParticipants(ps);
    if (ps.some((p) => p.user_id === uid)) setJoined(true);
    const ph = s ? phaseOf(s) : 'lobby';
    if (ph === 'lobby') {
      setGroups([]);
      setQuestions([]);
      setPaper(null);
      return;
    }
    const [gs, qs] = await Promise.all([fetchGroups(sessionId), fetchQuestions(sessionId)]);
    setGroups(gs);
    setQuestions(qs);
    setPaper(ph === 'grouped' ? null : await fetchLatestPaper(sessionId));
  }, [sessionId, uid]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await refresh();
      } catch (e) {
        if (alive) setMsg((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // 实时信号 + 6 秒兜底轮询（APK / 教室网络下 realtime 偶有掉线，阶段不能因此卡住）
  useEffect(() => subscribeSim(sessionId, () => void refresh()), [sessionId, refresh]);
  useEffect(() => {
    const id = window.setInterval(() => void refresh(), 6000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // 迟到者：分组已经开始、自己还没组 → 补一次 join（RPC 会塞进人数最少的组）
  useEffect(() => {
    if (syncedRef.current || !joined || !session) return;
    const me = participants.find((p) => p.user_id === uid);
    if (!me) return;
    if (me.group_id || phaseOf(session) === 'lobby') {
      syncedRef.current = true;
      return;
    }
    syncedRef.current = true;
    void (async () => {
      try {
        await joinLobby(sessionId);
        await refresh();
      } catch (e) {
        setMsg(simErrorMessage(e));
      }
    })();
  }, [joined, session, participants, uid, sessionId, refresh]);

  const doJoin = async () => {
    setBusy(true);
    setMsg('');
    try {
      await joinLobby(sessionId);
      setJoined(true);
      await refresh();
    } catch (e) {
      setMsg(simErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const me = participants.find((p) => p.user_id === uid) ?? null;
  const myGroup = groups.find((g) => g.id === me?.group_id) ?? null;
  const teammates = useMemo(
    () => participants.filter((p) => myGroup && p.group_id === myGroup.id && p.user_id !== uid),
    [participants, myGroup, uid],
  );
  const groupLimit = groupLimitOf(session);
  const myQuestions = useMemo(
    () => questions.filter((q) => myGroup && q.group_id === myGroup.id),
    [questions, myGroup],
  );
  const boundIds = useMemo(
    () => new Set(drafts.map((d) => d.id).filter((x): x is string => !!x)),
    [drafts],
  );
  const dbOnly = myQuestions.filter((q) => !boundIds.has(q.id));
  const total = myQuestions.length + drafts.filter((d) => !d.id).length;
  const full = total >= groupLimit;

  const phase = session ? phaseOf(session) : 'lobby';
  const editable = phase === 'grouped' && joined;

  const removeCard = async (card: DraftCard) => {
    setMsg('');
    try {
      if (card.id) await deleteQuestion(sessionId, card.id);
      setDrafts((ds) => ds.filter((d) => d.key !== card.key));
      await refresh();
    } catch (e) {
      setMsg(simErrorMessage(e));
    }
  };

  const removeDbQuestion = async (q: SimQuestion) => {
    setMsg('');
    try {
      await deleteQuestion(sessionId, q.id);
      await refresh();
    } catch (e) {
      setMsg(simErrorMessage(e));
    }
  };

  // 调序只改自己那道题的 position：服务端只允许作者写自己的行，
  // 所以不去重排全组（组内最多 10 题，够表达「放前 / 放后」）。
  const moveQuestion = async (dir: -1 | 1, current: { id: string | null; qtype: SimQType; stem: string; options: SimOption[] }) => {
    if (!current.id) return;
    const idx = myQuestions.findIndex((q) => q.id === current.id);
    const neighbor = idx >= 0 ? myQuestions[idx + dir] : undefined;
    if (!neighbor) return;
    setMsg('');
    try {
      await saveQuestion({
        sessionId,
        questionId: current.id,
        qtype: current.qtype,
        stem: current.stem,
        options: current.options,
        position: dir < 0 ? neighbor.position - 1 : neighbor.position + 1,
      });
      await refresh();
    } catch (e) {
      setMsg(simErrorMessage(e));
    }
  };

  if (loading) return <div className="card"><p className="muted">正在载入模拟调研…</p></div>;

  if (!session) {
    return (
      <div className="card">
        <h2>模拟调研</h2>
        <p className="muted">这场活动已经结束了。</p>
      </div>
    );
  }

  // 老师在别的设备上结束了活动
  if (session.state !== 'running') {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{session.title || '模拟调研'}</h2>
        <p className="muted" style={{ marginBottom: 0 }}>这场活动已经结束。</p>
      </div>
    );
  }

  const header = (
    <div className="card" style={{ marginBottom: '0.8rem' }}>
      <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong>{session.title || '模拟调研'}</strong>
        <span className="badge">{PHASE_LABEL[phase] ?? phase}</span>
        {myGroup && <span className="badge">第 {myGroup.group_no} 组</span>}
        <span className="spacer" />
        <span className="muted" style={{ fontSize: '0.85rem' }}>已加入 {participants.length} 人</span>
      </div>
      {phase === 'grouped' && myGroup && (
        <p className="muted" style={{ fontSize: '0.85rem', margin: '0.4rem 0 0' }}>
          队友：{teammates.length ? teammates.map((p) => p.name || '同学').join('、') : '这组暂时只有你'} · 在教室里坐到一起
        </p>
      )}
    </div>
  );

  if (!joined) {
    return (
      <>
        {header}
        <div className="card">
          <p>老师正在进行模拟调研，点击加入。</p>
          <button className="primary" onClick={doJoin} disabled={busy}>{busy ? '加入中…' : '加入'}</button>
          {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
        </div>
      </>
    );
  }

  if (phase === 'lobby') {
    return (
      <>
        {header}
        <div className="card">
          <p>已加入，等老师开始分组。</p>
          <p className="muted" style={{ fontSize: '0.9rem', marginBottom: 0 }}>
            现在 {participants.length} 人。分组是随机的，人齐后老师会点「开始分组」。
          </p>
        </div>
      </>
    );
  }

  if (phase === 'grouped' && myGroup) {
    return (
      <>
        {header}
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong>你们的问卷（{total}/{groupLimit} 题）</strong>
            <span className="spacer" />
            <button className="ghost" onClick={() => setPreview((v) => !v)}>
              {preview ? '返回编辑' : '预览'}
            </button>
          </div>
          <p className="muted" style={{ fontSize: '0.82rem', margin: '0.35rem 0 0' }}>
            全组共用这份问卷：各人加各自的题，只有作者能改自己的题。改完自动保存。
          </p>
        </div>

        {preview ? (
          <div className="card">
            <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>这是被调查者看到的样子</p>
            {(dbOnly.length + drafts.length) === 0 ? (
              <p className="muted">还没有题目。</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {dbOnly.map((q) => (
                  <SimQuestionView key={q.id} q={q} />
                ))}
                {drafts.map((d) => (
                  <SimQuestionView key={d.key} q={d} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {dbOnly.map((q, i) => {
              const mine = q.author_id === uid;
              const order = myQuestions.findIndex((x) => x.id === q.id);
              return (
                <div key={q.id} style={{ marginBottom: '0.8rem' }}>
                  <SimQuestionCard
                    sessionId={sessionId}
                    initial={{ id: q.id, qtype: q.qtype, stem: q.stem, options: q.options }}
                    index={i}
                    canEdit={mine}
                    readOnly={!mine || !editable}
                    readOnlyNote={
                      !mine
                        ? '这是队友的题，只有作者能改。想改？跟他说一声，由他来改。'
                        : phase !== 'grouped'
                          ? '问卷已定稿，不能再改。'
                          : undefined
                    }
                    canMoveUp={mine && editable && order > 0}
                    canMoveDown={mine && editable && order >= 0 && order < myQuestions.length - 1}
                    onBound={() => void refresh()}
                    onSaved={() => void refresh()}
                    onDelete={() => void removeDbQuestion(q)}
                    onMove={(dir, cur) => void moveQuestion(dir, cur)}
                  />
                </div>
              );
            })}

            {drafts.map((d, i) => {
              const order = d.id ? myQuestions.findIndex((x) => x.id === d.id) : -1;
              return (
                <div key={d.key} style={{ marginBottom: '0.8rem' }}>
                  <SimQuestionCard
                    sessionId={sessionId}
                    initial={{ id: d.id, qtype: d.qtype, stem: d.stem, options: d.options }}
                    index={dbOnly.length + i}
                    canEdit={editable}
                    readOnly={!editable}
                    readOnlyNote={phase !== 'grouped' ? '问卷已定稿，不能再改。' : undefined}
                    canMoveUp={editable && !!d.id && order > 0}
                    canMoveDown={editable && !!d.id && order >= 0 && order < myQuestions.length - 1}
                    onBound={(id) => setDrafts((ds) => ds.map((x) => (x.key === d.key ? { ...x, id } : x)))}
                    onSaved={() => void refresh()}
                    onDelete={() => void removeCard(d)}
                    onMove={(dir, cur) => void moveQuestion(dir, cur)}
                  />
                </div>
              );
            })}

            {editable && (
              <div className="card">
                <button
                  className="primary"
                  disabled={full}
                  onClick={() => {
                    if (full) return;
                    setDrafts((ds) => [
                      ...ds,
                      {
                        key: `n${Date.now()}${Math.round(Math.random() * 1000)}`,
                        id: null,
                        qtype: 'single',
                        stem: '',
                        options: emptyOptions(2),
                      },
                    ]);
                  }}
                >
                  + 添加题目
                </button>
                {full && (
                  <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 0 }}>
                    本组已满 {groupLimit} 题（老师可调），可以删一题再加。
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
      </>
    );
  }

  if (phase === 'grouped' && !myGroup) {
    return (
      <>
        {header}
        <div className="card"><p>老师正在分组，稍等片刻…</p></div>
      </>
    );
  }

  if (phase === 'frozen') {
    return (
      <>
        {header}
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <p style={{ marginTop: 0 }}>问卷已定稿，接下来老师会请三位「受访者」来填。</p>
          <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 0 }}>
            共 {paper?.items.length ?? 0} 题。先想想：如果是你，会怎么答？
          </p>
        </div>
        {paper && paper.items.length > 0 && (
          <div className="card">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              {paper.items.map((it, i) => (
                <div key={it.qid}>
                  <span className="badge">{i + 1}</span>
                  <SimQuestionView q={it} />
                </div>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {header}
      <div className="card center">
        <h3>{phase === 'answered' ? '三个人都答完了' : '请看大屏'}</h3>
        <p className="muted" style={{ marginBottom: 0 }}>
          {phase === 'answered'
            ? '老师会逐题公布他们的答案，然后才公布他们心里真正的想法。'
            : '答案与内心的揭晓在大屏上进行，手机上不用操作。'}
        </p>
        <p className="muted" style={{ fontSize: '0.82rem', marginTop: '0.4rem', marginBottom: 0 }}>
          大屏上的三位受访者由 AI 按人设卡扮演，不是真人 —— 这正是我们要看「问卷量到了什么、漏掉了什么」的地方。
        </p>
      </div>
    </>
  );
}
