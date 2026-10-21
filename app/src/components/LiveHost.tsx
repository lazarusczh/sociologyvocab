// 教师端：创建 / 控制课堂拼写竞赛
//
// 节奏（见《实时多人在线功能规划.md》第七节）：
//   淘汰段：多人同场，难度按轮次递增；答对者存活，答错 / 超时出局
//   剩 ≤3 人 → 切到抢答段：一题定胜负，第一个答对者胜出（同一时间窗内并列）
//   抢答段结算完毕 = 回合结束，可按「开始下一回合」重置（全员回到场上）
//
// 两个易踩的点：
//   1) 「本回合存活者」名单（live_spell_state）必须在**开第一轮之前**初始化，
//      否则学生还没加入、名单是空的 → 结算时谁都匹配不到，表现为「答对了也不算存活」。
//   2) 抢答段结算要**自动**：有人答对后等「并列窗 + 缓冲」再收，网络抖动由窗口吸收。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import {
  BUZZ_PERCENTILE,
  closeSession,
  createSession,
  DEFAULT_LIVE_CONFIG,
  fetchGroupRounds,
  fetchGroupState,
  fetchLatestRound,
  fetchParticipants,
  fetchRecentHostSession,
  fetchRoundTerm,
  fetchRunningSession,
  fetchSessionState,
  fetchUsedTermIds,
  knockoutPercentile,
  openRound,
  pickRoundTerm,
  reopenSession,
  roundSeconds,
  settleRound,
  spellPrompt,
  startGroup,
  subscribeLive,
  type LiveParticipant,
  type LiveRound,
  type LiveSession,
  type LiveSettleResult,
  type LiveStateRow,
} from '../lib/live';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';
import LiveBoard from './LiveBoard';
import LiveOralHost from './LiveOralHost';

// 输入框 -> 秒数：允许教师留空（回落默认），并夹在 5s ~ 600s 之间
function toSeconds(v: string, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || v.trim() === '') return fallback;
  return Math.min(600, Math.max(5, Math.round(n)));
}

export default function LiveHost() {
  const { authUser, vocab, papers, categories } = useStore();
  const uid = authUser?.id ?? '';

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [participants, setParticipants] = useState<LiveParticipant[]>([]);
  const [round, setRound] = useState<LiveRound | null>(null);
  const [groupNo, setGroupNo] = useState(1);
  const [roundCountInGroup, setRoundCountInGroup] = useState(0);
  const [groupState, setGroupState] = useState<LiveStateRow[]>([]);
  const [sessionState, setSessionState] = useState<LiveStateRow[]>([]);
  const [termText, setTermText] = useState<string | null>(null);
  const [usedIds, setUsedIds] = useState<Set<string>>(new Set());
  // 下一轮打哪一段：教师手动切换时优先（「进入抢答段」），否则跟随当前轮次 —— 刷新页面后 stage 不会丢
  const [stageOverride, setStageOverride] = useState<'knockout' | 'buzz' | null>(null);
  const [lastSettle, setLastSettle] = useState<LiveSettleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const autoSettledFor = useRef<string | null>(null);

  const stage: 'knockout' | 'buzz' = stageOverride ?? round?.stage ?? 'knockout';

  // 创建前先选模式（两种模式刻意分开：拼写竞赛 / 口头速答）
  const [mode, setMode] = useState<'spell' | 'oral'>('spell');

  // 出题范围（仅拼写竞赛在创建前可选；创建后写进会话 config，之后只读）
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [units, setUnits] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('all');

  // 每题限时（创建时由教师决定，写进会话 config；创建后不可改）—— 存字符串，便于清空重输
  const [koSeconds, setKoSeconds] = useState(String(DEFAULT_LIVE_CONFIG.knockout_seconds));
  const [buzzSeconds, setBuzzSeconds] = useState(String(DEFAULT_LIVE_CONFIG.buzz_seconds));

  // 最近一场自己发起的活动：已结束时提供「重新开启（保留参与者）」
  const [lastSession, setLastSession] = useState<LiveSession | null>(null);

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(id);
  }, []);

  // 出题池：会话已创建时用会话里保存的范围（换设备/刷新后一致），否则用界面上的选择
  const pool = useMemo(() => {
    const f = session?.config?.filter;
    const p = session ? (f?.papers?.[0] ?? 'all') : paper;
    const c = session ? (f?.categories?.[0] ?? 'all') : cat;
    const u = session ? (f?.units ?? []) : units;
    const t = session ? (f?.type ?? 'all') : typeFilter;
    return filterByPaperCat(vocab, p, c, u).filter((i) => t === 'all' || i.type === t);
  }, [session, vocab, paper, cat, units, typeFilter]);

  const rangeLabel = useMemo(() => {
    const f = session?.config?.filter;
    if (!f) return '全部';
    const typeText = f.type === 'term' ? '术语' : f.type === 'scholar' ? '学者' : '综合';
    const scope = [f.papers?.[0], f.categories?.[0], f.units?.length ? `${f.units.length} 个单元` : '']
      .filter((x) => x && x !== 'all')
      .join(' ');
    return `${scope || '全部'} · ${typeText}`;
  }, [session]);

  const refresh = useCallback(
    async (sid: string) => {
      const [ps, stAll] = await Promise.all([fetchParticipants(sid), fetchSessionState(sid)]);
      setParticipants(ps);
      setSessionState(stAll);

      // 「当前回合」以状态行的最大 group_no 为准（startGroup 会立刻写入新回合的行）。
      // 不能只看最新轮次：刚点完「开新一轮」时新回合还没有任何轮次，只看轮次会被上一回合拉回去，
      // 于是下一次开轮又开在旧回合里（旧回合的人已全部出局），表现为「新一轮开不起来」。
      const latest = await fetchLatestRound(sid);
      const stateGroup = stAll.reduce((m, s) => Math.max(m, s.group_no), 0);
      const curGroup = Math.max(stateGroup, latest?.group_no ?? 0, 1);
      setGroupNo(curGroup);

      const r = latest && latest.group_no === curGroup ? latest : null;
      setRound(r);
      if (r) {
        setGroupState(await fetchGroupState(sid, curGroup));
        setRoundCountInGroup((await fetchGroupRounds(sid, curGroup)).length);
        const termId = await fetchRoundTerm(r.id);
        setTermText(termId ? (vocab.find((v) => v.id === termId)?.term ?? termId) : null);
      } else {
        setGroupState(await fetchGroupState(sid, curGroup));
        setRoundCountInGroup(0);
        setTermText(null);
      }
      setUsedIds(await fetchUsedTermIds(sid));
    },
    [vocab],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetchRunningSession();
        if (!alive) return;
        setSession(s);
        if (s) await refresh(s.id);
        // 没有进行中的活动时，看一眼上一场（已结束的）—— 用于「重新开启（保留参与者）」
        const recent = uid ? await fetchRecentHostSession(uid) : null;
        if (alive) setLastSession(recent && recent.state !== 'running' && recent.kind === 'spell' ? recent : null);
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh, uid]);

  useEffect(() => {
    // ⚠️ 口头速答**不能**在这里订阅：那种会话由 LiveOralHost 自己订阅。
    // 两边同时订阅**同名 channel**（`live:<sessionId>`）时，后到的那次会在
    // `subscribe()` 之后才 `.on(...)`，Supabase 直接抛
    // "cannot add postgres_changes callbacks ... after subscribe()"，
    // 而 effect 抛错 = React 卸载整棵树 = **整页白屏**（2026-10-08 事故）。
    // hooks 都在条件 return 之前，所以必须在这里显式跳过，不能靠"不渲染"来回避。
    if (!session || session.kind === 'oral') return;
    return subscribeLive(session.id, () => void refresh(session.id));
  }, [session, refresh]);

  const handleCreate = async () => {
    setBusy(true);
    setMsg('');
    try {
      // 注意：这里**不**初始化回合名单 —— 学生此刻还没加入，名单会空。
      // 名单在「开第一轮」之前初始化（见 handleNextRound）。
      const s = await createSession(uid, 'spell', '课堂拼写竞赛', {
        knockout_seconds: toSeconds(koSeconds, DEFAULT_LIVE_CONFIG.knockout_seconds),
        buzz_seconds: toSeconds(buzzSeconds, DEFAULT_LIVE_CONFIG.buzz_seconds),
        filter: {
          papers: paper === 'all' ? [] : [paper],
          categories: cat === 'all' ? [] : [cat],
          units,
          type: typeFilter,
        },
      });
      setSession(s);
      setGroupNo(1);
      setStageOverride(null);
      setLastSettle(null);
      autoSettledFor.current = null;
      await refresh(s.id);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateOral = async () => {
    setBusy(true);
    setMsg('');
    try {
      const s = await createSession(uid, 'oral', '口头速答', DEFAULT_LIVE_CONFIG);
      setSession(s);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 重新开启上一场（同一 session_id）：participants 与历史都保留，学生不用重新加入
  const handleReopen = async () => {
    if (!lastSession) return;
    setBusy(true);
    setMsg('');
    try {
      await reopenSession(lastSession.id);
      // 直接预置新回合：在场同学全部回到场上（reopen 之后 participants 仍是原来那批）
      const stAll = await fetchSessionState(lastSession.id);
      const next = stAll.reduce((m, s) => Math.max(m, s.group_no), 0) + 1;
      const added = await startGroup(lastSession.id, next);
      setSession({ ...lastSession, state: 'running', closed_at: null });
      setStageOverride(null);
      setLastSettle(null);
      autoSettledFor.current = null;
      await refresh(lastSession.id);
      setLastSession(null);
      setMsg(`已重新开启上一场：${added} 名原有参与者直接进入第 ${next} 回合，点「开第一轮」即可。`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleNextRound = async () => {
    if (!session) return;
    setBusy(true);
    setMsg('');
    try {
      // 本回合还没开过轮 → 先初始化「本回合存活者」（此时学生已加入）
      if (roundCountInGroup === 0) {
        await startGroup(session.id, groupNo);
      }

      const nextNo = roundCountInGroup + 1;
      const pct = stage === 'buzz'
        ? BUZZ_PERCENTILE
        : knockoutPercentile(nextNo, session.config?.round_limit || 10);
      const item = pickRoundTerm(pool, usedIds, pct);
      if (!item) {
        setMsg('这个范围里可抽的词已用尽（本场出池已覆盖）。');
        return;
      }
      await openRound({
        sessionId: session.id,
        groupNo,
        roundNo: nextNo,
        stage,
        prompt: spellPrompt(item),
        termId: item.id,
        seconds: roundSeconds(session.config, stage),
      });
      setTermText(item.term);
      setUsedIds((prev) => new Set(prev).add(item.id));
      setLastSettle(null);
      autoSettledFor.current = null;
      setMsg(`已开本轮：${stage === 'buzz' ? '抢答' : '淘汰'}段 · 难度分位 ${pct.toFixed(2)}`);
      await refresh(session.id);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSettle = useCallback(
    async (roundId: string) => {
      if (!session) return;
      setBusy(true);
      setMsg('');
      try {
        const res = await settleRound(roundId, session.config?.buzz_window_ms ?? 1000);
        setLastSettle(res);
        await refresh(session.id);
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [session, refresh],
  );

  // 开新一轮：保留在场参与者，只把回合号 +1（不新建会话，所以学生不用重新加入）
  const handleNextGroup = async () => {
    if (!session) return;
    setBusy(true);
    setMsg('');
    try {
      const maxGroup = sessionState.reduce((m, s) => Math.max(m, s.group_no), 0);
      const next = Math.max(groupNo, maxGroup) + 1;
      const added = await startGroup(session.id, next);
      setGroupNo(next);
      setStageOverride(null);
      setLastSettle(null);
      autoSettledFor.current = null;
      setMsg(`第 ${next} 回合已就绪：${added} 名在场同学全部回到场上，不用重新加入。可以开第一轮了。`);
      await refresh(session.id);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 抢答段自动结算
  useEffect(() => {
    if (!round || !session) return;
    if (round.stage !== 'buzz' || round.state !== 'open' || round.correct_count === 0) return;
    if (autoSettledFor.current === round.id) return;
    const w = session.config?.buzz_window_ms ?? 1000;
    const id = window.setTimeout(() => {
      autoSettledFor.current = round.id;
      void handleSettle(round.id);
    }, w + 300);
    return () => window.clearTimeout(id);
  }, [round, session, handleSettle]);

  const handleClose = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await closeSession(session.id);
      // 记住这一场：创建页可「重新开启（保留参与者）」，学生不用重新加入
      setLastSession({ ...session, state: 'closed', closed_at: new Date().toISOString() });
      setSession(null);
      setRound(null);
      setGroupState([]);
      setSessionState([]);
      setParticipants([]);
      setLastSettle(null);
      setMsg('课堂活动已结束。');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card"><p className="muted">正在检查课堂活动…</p></div>;

  if (!session) {
    // 两种模式刻意分开：拼写竞赛需要题库范围；口头速答不需要（题由教师口述）。
    // 布局与「拼写默写」等日常练习一致：CategoryFilter 自带一层卡片，只并列再加一段，不要再套卡片。
    return (
      <div>
        <h1>创建课堂活动</h1>

        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <p className="muted" style={{ marginTop: 0 }}>先选一种模式：</p>
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className={mode === 'spell' ? 'primary' : 'ghost'} onClick={() => setMode('spell')}>拼写竞赛</button>
            <button className={mode === 'oral' ? 'primary' : 'ghost'} onClick={() => setMode('oral')}>口头速答</button>
          </div>
          <p className="muted" style={{ fontSize: '0.9rem', marginBottom: 0 }}>
            {mode === 'spell'
              ? '全班同一道题、答错出局、剩 3 人抢答定胜负。需要先选定题库范围。'
              : '问题由你口头说，学生打字作答、随时可改；投屏匿名展示答案。不需要题库范围。'}
          </p>
        </div>

        {mode === 'spell' ? (
          <>
            <CategoryFilter
              items={vocab}
              papers={papers}
              categories={categories}
              paper={paper}
              onPaperChange={(p) => { setPaper(p); setCat('all'); setUnits([]); }}
              cat={cat}
              onCatChange={(c) => { setCat(c); setUnits([]); }}
              units={units}
              onUnitsChange={setUnits}
              typeFilter={typeFilter}
              onTypeChange={setTypeFilter}
            />
            <div className="card">
              <p className="muted" style={{ marginTop: 0 }}>
                范围即出题池（与日常练习同一套筛选）；发起后学生端会出现加入入口。
              </p>
              <p className="muted" style={{ fontSize: '0.9rem' }}>符合范围的词条：{pool.length} 条</p>

              <div className="row" style={{ gap: '0.9rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
                <label>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>淘汰段每题限时（秒）</span>
                  <input
                    type="number"
                    min={5}
                    max={600}
                    step={5}
                    value={koSeconds}
                    onChange={(e) => setKoSeconds(e.target.value)}
                    style={{ maxWidth: '7rem' }}
                  />
                </label>
                <label>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>抢答段每题限时（秒）</span>
                  <input
                    type="number"
                    min={5}
                    max={600}
                    step={5}
                    value={buzzSeconds}
                    onChange={(e) => setBuzzSeconds(e.target.value)}
                    style={{ maxWidth: '7rem' }}
                  />
                </label>
              </div>
              <p className="muted" style={{ fontSize: '0.85rem', marginBottom: '0.6rem' }}>
                限时只影响这一场的每一题（5 ~ 600 秒，留空用默认 {DEFAULT_LIVE_CONFIG.knockout_seconds}s / {DEFAULT_LIVE_CONFIG.buzz_seconds}s）；创建后不再改动。到点未提交视为出局。
              </p>

              <button className="primary" onClick={handleCreate} disabled={busy || pool.length === 0}>
                {busy ? '创建中…' : '开始拼写竞赛'}
              </button>

              {lastSession && (
                <div style={{ marginTop: '0.9rem', borderTop: '1px dashed var(--border)', paddingTop: '0.7rem' }}>
                  <p className="muted" style={{ fontSize: '0.85rem', margin: '0 0 0.4rem' }}>
                    上一场「{lastSession.title || '课堂拼写竞赛'}」已结束，参与者名单还在。
                  </p>
                  <button className="ghost" onClick={handleReopen} disabled={busy}>
                    {busy ? '开启中…' : '重新开启上一场（保留参与者，不用重新加入）'}
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="card">
            <button className="primary" onClick={handleCreateOral} disabled={busy}>
              {busy ? '创建中…' : '开始口头速答'}
            </button>
          </div>
        )}

        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
      </div>
    );
  }

  // 口头速答交给它自己的控制台（与拼写竞赛完全分开）
  if (session.kind === 'oral') {
    return <LiveOralHost session={session} onExit={handleClose} />;
  }

  const aliveCount = groupState.filter((s) => s.out_round_no === null).length;
  const remain = round?.deadline_at
    ? Math.max(0, Math.ceil((new Date(round.deadline_at).getTime() - Date.now()) / 1000))
    : null;
  // 本回合结束以数据为准（抢答段结算过）：刷新页面 / 换设备后「开新一轮」按钮仍在
  const groupFinished = round?.stage === 'buzz' && round.state === 'settled';
  // 淘汰段把人淘汰光时也要放行，否则会卡在「无人可答」的回合里
  const needNewGroup = groupFinished || (round?.state === 'settled' && aliveCount === 0);
  const buzzReady = !needNewGroup && aliveCount > 0 && aliveCount <= 3 && stage === 'knockout';

  return (
    <>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>{session.title || '课堂活动'}</strong>
          <span className="badge">第 {groupNo} 回合</span>
          <span className="badge">{stage === 'buzz' ? '抢答段' : '淘汰段'}</span>
          <span className="muted" style={{ fontSize: '0.85rem' }}>范围：{rangeLabel}</span>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            限时 {roundSeconds(session.config, 'knockout')}s / {roundSeconds(session.config, 'buzz')}s
          </span>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            在场 {participants.length} 人 · 存活 {aliveCount} 人
          </span>
          <button className="ghost" onClick={handleClose} disabled={busy}>结束活动</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span className="muted">
            {round ? `第 ${round.round_no} 轮 · ${round.state === 'settled' ? '已结算' : '进行中'}` : '本回合尚未开轮'}
          </span>
          {remain !== null && round?.state === 'open' && (
            <span className={`badge ${remain <= 10 ? 'danger' : 'success'}`}>剩余 {remain}s</span>
          )}
          {round && <span className="muted">已答 {round.answered_count} 人 · 答对 {round.correct_count} 人</span>}
          <span className="spacer" />
          {needNewGroup ? (
            <button className="primary" onClick={handleNextGroup} disabled={busy}>开新一轮（保留参与者）</button>
          ) : (
            <>
              <button className="primary" onClick={handleNextRound} disabled={busy || round?.state === 'open'}>
                {round ? '开下一轮' : '开第一轮'}
              </button>
              {round?.state === 'open' && (
                <button className="ghost" onClick={() => void handleSettle(round.id)} disabled={busy}>提前结算本轮</button>
              )}
              {buzzReady && (
                <button className="primary" onClick={() => { setStageOverride('buzz'); setMsg('已切到抢答段：下一轮一题定胜负。'); }}>
                  进入抢答段
                </button>
              )}
            </>
          )}
        </div>

        {round && (
          <div style={{ marginTop: '0.7rem' }}>
            <div className="muted" style={{ fontSize: '0.85rem' }}>本轮题干（学生看到的）</div>
            <p style={{ margin: '0.2rem 0 0.6rem', lineHeight: 1.6 }}>{round.prompt}</p>
            {termText && (
              <p className="muted" style={{ fontSize: '0.9rem' }}>
                正确答案（仅本窗口可见）：<strong>{termText}</strong>
              </p>
            )}
          </div>
        )}

        {!round && (
          <p className="muted" style={{ marginTop: '0.5rem' }}>
            等学生都进来后点「开第一轮」。回合名单会在开轮那一刻生成，之后加入的同学从下一回合开始参与。
          </p>
        )}

        {needNewGroup && (
          <p className="muted" style={{ marginTop: '0.5rem' }}>
            本回合已结束。点「开新一轮（保留参与者）」会把在场 {participants.length} 人直接放进新回合 —— 学生不用重新加入，输入框也会自动清空。
          </p>
        )}

        {lastSettle && !lastSettle.already && (
          <p className="muted" style={{ marginTop: '0.5rem' }}>
            结算：{lastSettle.stage === 'buzz'
              ? `胜者 ${lastSettle.winners?.length ?? 0} 人${lastSettle.group_finished ? '，本回合结束' : ''}`
              : `存活 ${lastSettle.alive_after} 人（本轮淘汰 ${(lastSettle.alive_before ?? 0) - (lastSettle.alive_after ?? 0)} 人）`}
          </p>
        )}
        {msg && <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.9rem' }}>{msg}</p>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>存活表与积分</h3>
        <LiveBoard participants={participants} groupState={groupState} sessionState={sessionState} />
      </div>
    </>
  );
}
