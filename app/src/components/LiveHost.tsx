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
  fetchRoundTerm,
  fetchRunningSession,
  fetchSessionState,
  fetchUsedTermIds,
  knockoutPercentile,
  openRound,
  pickRoundTerm,
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

const KNOCKOUT_SECONDS = 45;  // 淘汰段每题限时
const BUZZ_SECONDS = 30;      // 抢答段每题限时

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
  const [stage, setStage] = useState<'knockout' | 'buzz'>('knockout');
  const [lastSettle, setLastSettle] = useState<LiveSettleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const autoSettledFor = useRef<string | null>(null);

  // 出题范围（仅创建前可选；创建后写进会话 config，之后只读）
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [units, setUnits] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('all');

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
      setParticipants(await fetchParticipants(sid));
      setSessionState(await fetchSessionState(sid));
      const r = await fetchLatestRound(sid);
      setRound(r);
      if (r) {
        setGroupNo(r.group_no);
        setGroupState(await fetchGroupState(sid, r.group_no));
        setRoundCountInGroup((await fetchGroupRounds(sid, r.group_no)).length);
        const termId = await fetchRoundTerm(r.id);
        setTermText(termId ? (vocab.find((v) => v.id === termId)?.term ?? termId) : null);
      } else {
        setGroupState([]);
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

  useEffect(() => {
    if (!session) return;
    return subscribeLive(session.id, () => void refresh(session.id));
  }, [session, refresh]);

  const handleCreate = async () => {
    setBusy(true);
    setMsg('');
    try {
      // 注意：这里**不**初始化回合名单 —— 学生此刻还没加入，名单会空。
      // 名单在「开第一轮」之前初始化（见 handleNextRound）。
      const s = await createSession(uid, 'spell', '课堂拼写竞赛', {
        ...DEFAULT_LIVE_CONFIG,
        filter: {
          papers: paper === 'all' ? [] : [paper],
          categories: cat === 'all' ? [] : [cat],
          units,
          type: typeFilter,
        },
      });
      setSession(s);
      setGroupNo(1);
      setStage('knockout');
      setLastSettle(null);
      autoSettledFor.current = null;
      await refresh(s.id);
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
        seconds: stage === 'buzz' ? BUZZ_SECONDS : KNOCKOUT_SECONDS,
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

  const handleNextGroup = async () => {
    if (!session) return;
    setBusy(true);
    setMsg('');
    try {
      const next = groupNo + 1;
      await startGroup(session.id, next);
      setGroupNo(next);
      setStage('knockout');
      setLastSettle(null);
      autoSettledFor.current = null;
      setMsg(`第 ${next} 回合已就绪（在场同学全部回到场上），可以开第一轮了。`);
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
    // 布局与「拼写默写」等日常练习一致：CategoryFilter 自带一层卡片，这里只并列再加一段，
    // 不要再套 <div className="card">（会变成卡片叠卡片）。
    return (
      <div>
        <h1>创建课堂活动</h1>
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
          <button className="primary" onClick={handleCreate} disabled={busy || pool.length === 0}>
            {busy ? '创建中…' : '开始课堂活动'}
          </button>
          {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
        </div>
      </div>
    );
  }

  const aliveCount = groupState.filter((s) => s.out_round_no === null).length;
  const remain = round?.deadline_at
    ? Math.max(0, Math.ceil((new Date(round.deadline_at).getTime() - Date.now()) / 1000))
    : null;
  const groupFinished = lastSettle?.group_finished === true;
  const buzzReady = !groupFinished && aliveCount <= 3 && stage === 'knockout';

  return (
    <>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>{session.title || '课堂活动'}</strong>
          <span className="badge">第 {groupNo} 回合</span>
          <span className="badge">{stage === 'buzz' ? '抢答段' : '淘汰段'}</span>
          <span className="muted" style={{ fontSize: '0.85rem' }}>范围：{rangeLabel}</span>
          <span className="spacer" />
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            在场 {participants.length} 人 · 存活 {aliveCount} 人
          </span>
          <button className="ghost" onClick={handleClose} disabled={busy}>结束活动</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span className="muted">
            {round ? `第 ${round.round_no} 轮 · ${round.state === 'settled' ? '已结算' : '进行中'}` : '本回合尚未开轮'}
          </span>
          {remain !== null && round?.state === 'open' && (
            <span className={`badge ${remain <= 10 ? 'danger' : 'success'}`}>剩余 {remain}s</span>
          )}
          {round && <span className="muted">已答 {round.answered_count} 人 · 答对 {round.correct_count} 人</span>}
          <span className="spacer" />
          {groupFinished ? (
            <button className="primary" onClick={handleNextGroup} disabled={busy}>开始下一回合</button>
          ) : (
            <>
              <button className="primary" onClick={handleNextRound} disabled={busy || round?.state === 'open'}>
                {round ? '开下一轮' : '开第一轮'}
              </button>
              {round?.state === 'open' && (
                <button className="ghost" onClick={() => void handleSettle(round.id)} disabled={busy}>提前结算本轮</button>
              )}
              {buzzReady && (
                <button className="primary" onClick={() => { setStage('buzz'); setMsg('已切到抢答段：下一轮一题定胜负。'); }}>
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
