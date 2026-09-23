import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useStore, useStudySession, useCelebrateCheckIn, useElapsedTimer } from '../lib/store';
import { newEventId } from '../lib/xp';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';
import { conceptIdOf } from '../lib/relationSuggest';
import {
  buildRangeGraph, randomOpenPath, randomTargetPath, buildOptions,
  matchInputToCid, shortestDist, nodesWithin, smartHint,
  type ChainRun, type ChainMode,
} from '../lib/chain';
import type { VocabItem } from '../lib/types';

const OPEN_STEPS = 8; // 仅起点模式：目标步数（选择/输入一致）
const TARGET_MIN = 3; // 起点+终点：终点距起点最少跳数
const TARGET_MAX = 6; // 终点距起点最多跳数

type AnswerKind = 'choice' | 'input';

interface InputRun {
  mode: ChainMode;
  cur: string;           // 当前所在概念组 cid
  target: string | null; // target 模式终点；open 为 null
  goal: number | null;   // open 目标步数；target 为 null（无上限自由探索）
  history: string[];     // 走过的 cid（含起点与当前）
  refPath: string[] | null; // target 模式参考答案最短路径（cid 序列）
}

const betaTag = <span style={{ fontSize: '0.65rem', verticalAlign: 'super', color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.02em' }}>Beta</span>;

export default function LogicChain() {
  const { vocab, recordItem, recordChainComplete, papers, categories } = useStore();
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [units, setUnits] = useState<string[]>([]);
  const [kind, setKind] = useState<AnswerKind>('choice'); // 作答方式：选择 / 默写输入
  const [inDeg, setInDeg] = useState(1); // 文字输入模式可接度数：1=相邻 / 2=放宽到隔一跳
  const [gaveUp, setGaveUp] = useState(false); // 文字输入 target 是否已放弃（查看答案）
  const [mode, setMode] = useState<ChainMode>('open');    // 子模式：仅起点 / 起点+终点
  const [genErr, setGenErr] = useState('');

  // —— 选择模式状态 ——
  const [run, setRun] = useState<ChainRun | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [score, setScore] = useState(0);

  // —— 默写输入模式状态 ——
  const [irun, setIrun] = useState<InputRun | null>(null);
  const [iText, setIText] = useState('');
  const [iMsg, setIMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const [hintCid, setHintCid] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // —— XP 结算相关 ——
  // 一局接龙 = 一个 session。服务端靠 unique(user_id, session_id) 保证「一局只结算一次」，
  // 所以这个 id 在一局开始时生成、整局内保持不变。
  const sessionRef = useRef<string>('');
  // 本局是否已结算过（React 严格模式下 effect 可能双跑；服务端唯一索引是最终兜底，
  // 这里只是少发一次无用请求）。
  const settledRef = useRef(false);
  // 每步用时（随事件上报；服务端会累加进当日打卡时长）。
  const timer = useElapsedTimer();

  const onPaperChange = (p: string) => { setPaper(p); setCat('all'); setUnits([]); };
  const onCatChange = (c: string) => { setCat(c); setUnits([]); };

  const filtered = useMemo(
    () => filterByPaperCat(vocab, paper, cat, units),
    [vocab, paper, cat, units],
  );
  const graph = useMemo(() => buildRangeGraph(filtered), [filtered]);
  const cids = useMemo(() => [...graph.nodes.keys()], [graph]);
  const itemOf = useCallback(
    (cid: string): VocabItem | undefined => filtered.find((i) => conceptIdOf(i) === cid),
    [filtered],
  );

  // 完成判定（供计时/庆祝）
  const choiceTotal = run ? run.path.length - 1 : 0;
  const choiceDone = run !== null && stepIdx >= choiceTotal;
  const irunDone =
    irun !== null &&
    (irun.mode === 'open' ? irun.history.length - 1 >= (irun.goal ?? 0) : irun.cur === irun.target);
  const irunEnded = irunDone || (irun !== null && gaveUp); // 到终点/达标，或放弃后展示结果
  const inChoice = run !== null && !choiceDone;
  const inInput = irun !== null && !irunEnded;
  useStudySession(inChoice || inInput);
  useCelebrateCheckIn(choiceDone || irunDone); // 放弃不算达成，不触发庆祝

  // 走完整条线 ⇒ 结算一次 XP（**只此一次**）。
  //
  // 为什么分值在完成时才给：接龙每一步的 answer 事件，服务端 xp_of() 直接返回 0
  // （见 db-migration-xp-c.sql：`when p_mode = 'chain' then 0`）—— 它只为掌握度、
  // 打卡题数与时长而存在。真正的分只在 chain_complete 上结算，于是：
  //   · 「回退刷分」（undoStep 不撤销已发的分）与「绕远刷分」（无步数上限地走相邻概念）
  //     两个漏洞**自动失效**，无需单独修代码；
  //   · 中途放弃（giveUp）自然一分不得，不必额外判罚。
  // 分值取决于「路线 + 作答方式」，由服务端按 chain_mode / chain_kind 查表，客户端不指定。
  useEffect(() => {
    if (settledRef.current) return;
    const sid = sessionRef.current;
    if (!sid) return;
    if (run && choiceDone) {
      settledRef.current = true;
      const itemId = itemOf(run.path[0])?.id;
      if (itemId) recordChainComplete({ itemId, sessionId: sid, chainMode: run.mode, chainKind: 'choice' });
    } else if (irun && irunDone) {
      settledRef.current = true;
      const itemId = itemOf(irun.history[0])?.id;
      if (itemId) recordChainComplete({ itemId, sessionId: sid, chainMode: irun.mode, chainKind: 'input' });
    }
  }, [choiceDone, irunDone, run, irun, itemOf, recordChainComplete]);

  // ===== 开始 =====
  // 开一局：换新的 session id（服务端按它保证「一局只结算一次」），
  // 并重置「本局已结算」标记与每步计时。
  const startSession = () => {
    sessionRef.current = newEventId();
    settledRef.current = false;
    timer.reset();
  };

  const startChoice = () => {
    setGenErr('');
    const attempt =
      mode === 'target'
        ? randomTargetPath(graph, TARGET_MIN, TARGET_MAX)
        : (() => {
            const p = randomOpenPath(graph, OPEN_STEPS);
            return p ? { path: p, target: null as string | null } : null;
          })();
    if (!attempt) {
      setGenErr('这个范围内能连起来的概念太少了，试试扩大范围（选整卷或「全部」）再开始。');
      return;
    }
    setRun({ mode, path: attempt.path, target: mode === 'target' ? attempt.target : null });
    setStepIdx(0);
    setChosen(null);
    setScore(0);
    setIrun(null);
    startSession();
  };

  const startInput = () => {
    setGenErr('');
    setGaveUp(false);
    let start: string;
    let target: string | null = null;
    let refPath: string[] | null = null;
    if (mode === 'target') {
      const attempt = randomTargetPath(graph, TARGET_MIN, TARGET_MAX);
      if (!attempt) {
        setGenErr('这个范围内找不到合适的一对起点与终点，试试扩大范围再开始。');
        return;
      }
      start = attempt.path[0];
      target = attempt.target;
      refPath = attempt.path; // 保存参考答案最短路径
    } else {
      const starters = cids.filter((c) => (graph.neighbors.get(c) ?? []).length >= 2);
      const pool = starters.length ? starters : cids.filter((c) => (graph.neighbors.get(c) ?? []).length >= 1);
      if (pool.length === 0) {
        setGenErr('这个范围内能连起来的概念太少了，试试扩大范围再开始。');
        return;
      }
      start = pool[Math.floor(Math.random() * pool.length)];
    }
    setIrun({ mode, cur: start, target, goal: mode === 'open' ? OPEN_STEPS : null, history: [start], refPath });
    setIText('');
    setIMsg(null);
    setHintCid(null);
    setRun(null);
    startSession();
  };

  const start = () => (kind === 'choice' ? startChoice() : startInput());

  const exitRun = () => {
    setRun(null); setIrun(null); setChosen(null); setStepIdx(0); setScore(0);
    setIText(''); setIMsg(null); setHintCid(null); setGaveUp(false);
    sessionRef.current = ''; // 退出本局：作废 session，避免残留状态再触发结算
    settledRef.current = false;
  };

  // ===== 选择模式：作答 =====
  const cur = inChoice && !choiceDone ? run!.path[stepIdx] : null;
  const curItem = cur ? itemOf(cur) : undefined;
  const correctCid = inChoice && !choiceDone ? run!.path[stepIdx + 1] : null;
  const targetItem = run?.target ? itemOf(run.target) : undefined;

  const options = useMemo(() => {
    if (!cur || !correctCid) return [] as string[];
    // target 模式把终点传进去：干扰项会混入「相邻但方向错误」的概念（见 chain.ts 注释），
    // 学生无法再靠「谁相邻」作答，必须逐跳判断前进方向。open 模式传 null，维持原口径。
    return buildOptions(graph, cids, cur, correctCid, 4, { target: run?.target ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, stepIdx, graph, cids, cur, correctCid]);

  const answer = (cid: string) => {
    if (chosen !== null || !curItem || !correctCid) return;
    const ok = cid === correctCid;
    setChosen(cid);
    if (ok) setScore((s) => s + 1);
    // 每步照常上报：服务端对 mode='chain' 的 answer 计 0 XP
    //（见 xp_of：`when p_mode = 'chain' then 0`），但**要**计题数与时长 ——
    // 也唯有如此，打卡题数才不会漏掉接龙。真正给分的只有完成时的 chain_complete。
    recordItem(curItem.id, ok, 'chain', {
      sessionId: sessionRef.current || undefined,
      elapsedMs: timer.lap(),
    });
  };
  const advance = () => {
    setStepIdx((i) => i + 1);
    setChosen(null);
    // 看正误与解析、再点「继续」的时间不该算进下一步的作答用时
    timer.reset();
  };

  // ===== 默写输入模式：作答 =====
  const iCurItem = inInput ? itemOf(irun!.cur) : undefined;
  const iTargetItem = irun?.target ? itemOf(irun.target) : undefined;
  const distLeft = irun && irun.target ? shortestDist(graph, irun.cur, irun.target) : null;

  const tryMove = () => {
    if (!irun || irunEnded) return;
    const q = iText.trim();
    if (!q) return;
    const m = matchInputToCid(filtered, q);
    if (!m) {
      setIMsg({ kind: 'warn', text: `词库中没找到「${q}」。检查拼写，或点「提示」看看能接什么。` });
      return;
    }
    if (m.cid === irun.cur) {
      setIMsg({ kind: 'warn', text: `「${m.item.term}」就是当前这个概念，要接的是它的下一个概念。` });
      return;
    }
    // 可接范围 = 相邻 inDeg 度（难度调节）
    const reach = nodesWithin(graph, irun.cur, inDeg);
    if (!reach.includes(m.cid)) {
      setIMsg({
        kind: 'warn',
        text: inDeg >= 2
          ? `「${m.item.term}」不在可接范围（相邻 ${inDeg} 度内）里。`
          : `「${m.item.term}」和「${iCurItem?.term}」不相邻，换一个相邻概念再试。`,
      });
      return;
    }
    const prev = irun.history.length >= 2 ? irun.history[irun.history.length - 2] : null;
    if (irun.mode === 'open' && prev === m.cid) {
      setIMsg({ kind: 'warn', text: `刚从这个概念过来，不能立刻走回头路，换个方向。` });
      return;
    }
    // 走成功了
    if (iCurItem) {
      recordItem(iCurItem.id, true, 'chain', {
        sessionId: sessionRef.current || undefined,
        elapsedMs: timer.lap(),
      });
    }
    setIrun({ ...irun, cur: m.cid, history: [...irun.history, m.cid] });
    setIText('');
    setIMsg(null);
    setHintCid(null);
    inputRef.current?.focus();
  };

  const showHint = () => {
    if (!irun || irunEnded) return;
    if (hintCid !== null) {
      // 已给过提示：只重申，不再重复扣分
      setIMsg({ kind: 'ok', text: `提示：可以接「${itemOf(hintCid)?.term ?? hintCid}」` });
      return;
    }
    const hint = smartHint(graph, irun.cur, { degree: inDeg, target: irun.target, history: irun.history });
    if (!hint) {
      setIMsg({ kind: 'warn', text: '这里似乎没有可走的概念了。' });
      return;
    }
    if (iCurItem) {
      // 首次看提示记一次答错（进错题本、扣掌握度）；与其它步一样只计题数、不计 XP
      recordItem(iCurItem.id, false, 'chain', {
        sessionId: sessionRef.current || undefined,
        elapsedMs: timer.lap(),
      });
    }
    setHintCid(hint.cid);
    setIMsg({ kind: 'ok', text: `提示：可以接「${itemOf(hint.cid)?.term ?? hint.cid}」${hint.note}` });
  };

  const undoStep = () => {
    if (!irun || irun.history.length <= 1) return;
    const history = irun.history.slice(0, -1);
    setIrun({ ...irun, cur: history[history.length - 1], history });
    setIText('');
    setIMsg(null);
    setHintCid(null);
    // 回退后重新计时。注意回退**不会**撤销已发出的题数与掌握度，也不会产生新 XP ——
    // 因为 XP 只在一局走完时结算一次，回退重走不改变结算结果。
    timer.reset();
  };

  // target 模式中途放弃：结束本局，直接看参考路线
  const giveUp = () => {
    if (!irun || irun.target == null || gaveUp) return;
    setGaveUp(true);
  };

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">⇄</div><p>请先导入词汇表</p></div>;
  }

  // ============ 准备屏 ============
  if (!run && !irun) {
    const modeLabel = (m: ChainMode) => (m === 'open' ? `仅起点 · 走 ${OPEN_STEPS} 步` : `起点 → 终点（${TARGET_MIN}~${TARGET_MAX} 跳）`);
    return (
      <div>
        <h1>逻辑接龙 {betaTag}</h1>
        <p className="muted" style={{ fontSize: '0.9rem' }}>
          概念之间有人工整理的逻辑关系（高于 / 低于 / 并列 / 相反）。接龙时你要从一个概念
          走到一个<strong>与它相邻</strong>的概念。Beta 试玩版，欢迎反馈手感。
        </p>
        <CategoryFilter
          items={vocab}
          papers={papers}
          categories={categories}
          paper={paper}
          onPaperChange={onPaperChange}
          cat={cat}
          onCatChange={onCatChange}
          units={units}
          onUnitsChange={setUnits}
        />
        <div className="card">
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>作答方式：</span>
            {([
              ['choice', '四选一'],
              ['input', '默写输入'],
            ] as [AnswerKind, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                style={{
                  fontSize: '0.85rem', padding: '0.35rem 0.8rem', borderRadius: 10,
                  background: kind === k ? 'var(--accent)' : 'var(--c-canvas)',
                  borderColor: kind === k ? 'var(--accent)' : 'var(--c-hairline-soft)',
                  color: kind === k ? '#fff' : 'var(--c-charcoal)',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>路线：</span>
            {(['open', 'target'] as ChainMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  fontSize: '0.85rem', padding: '0.35rem 0.8rem', borderRadius: 10,
                  background: mode === m ? 'var(--accent)' : 'var(--c-canvas)',
                  borderColor: mode === m ? 'var(--accent)' : 'var(--c-hairline-soft)',
                  color: mode === m ? '#fff' : 'var(--c-charcoal)',
                }}
              >
                {modeLabel(m)}
              </button>
            ))}
          </div>
          {kind === 'input' && (
            <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>可接范围：</span>
              {([1, 2] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setInDeg(d)}
                  style={{
                    fontSize: '0.85rem', padding: '0.35rem 0.8rem', borderRadius: 10,
                    background: inDeg === d ? 'var(--accent)' : 'var(--c-canvas)',
                    borderColor: inDeg === d ? 'var(--accent)' : 'var(--c-hairline-soft)',
                    color: inDeg === d ? '#fff' : 'var(--c-charcoal)',
                  }}
                >
                  {d === 1 ? '相邻（1 度）' : '放宽到 2 度'}
                </button>
              ))}
            </div>
          )}
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
            {kind === 'choice'
              ? '四选一：从四个候选中选出与当前概念相邻的那个，答对即前进。'
              : mode === 'open'
                ? `默写输入：每步打出与当前概念相连（${inDeg === 1 ? '相邻' : '1~2 度内'}）的概念名，共接 ${OPEN_STEPS} 步达成目标；答不出可看方向提示。`
                : `默写输入自由探索：从起点打相连（${inDeg === 1 ? '相邻' : '1~2 度内'}）的概念一路走到终点，不设步数上限，可随时回退；想不出可看提示，也可以中途放弃并查看参考答案路径。`}
          </p>
          {genErr && <p style={{ fontSize: '0.85rem', color: 'var(--danger)' }}>{genErr}</p>}
          <button className="primary" onClick={start} disabled={cids.length < 2} style={{ marginTop: '0.4rem' }}>
            {cids.length < 2 ? '当前范围可接概念不足' : '开始接龙'}
          </button>
        </div>
      </div>
    );
  }

  // ============ 默写输入：结果屏（到达 / 达标 / 中途放弃） ============
  if (irun && irunEnded) {
    const arrived = irun.mode === 'target' && irun.cur === irun.target;
    const stepsTaken = irun.history.length - 1;
    const refLen = irun.refPath ? irun.refPath.length - 1 : null;
    return (
      <div>
        <h1>逻辑接龙 {betaTag}</h1>
        <div className="card">
          <h2 style={{ marginBottom: '0.4rem' }}>
            {arrived ? '🎉 到达终点！' : irun.mode === 'target' ? '✋ 已放弃本局' : '🎉 达成目标步数！'}
          </h2>
          <p className="muted">
            {arrived
              ? `你走了 ${stepsTaken} 步到达「${iTargetItem?.term}」${refLen != null ? `（参考最短 ${refLen} 步）` : ''}`
              : irun.mode === 'target'
                ? `走了 ${stepsTaken} 步后放弃，参考路线见下。`
                : `一共接了 ${stepsTaken} 步。`}
          </p>

          <div style={{ fontWeight: 600, marginTop: '0.6rem' }}>你的路线</div>
          <div className="row" style={{ gap: '0.25rem', flexWrap: 'wrap', margin: '0.3rem 0' }}>
            {irun.history.map((cid, i) => {
              const it = itemOf(cid);
              const isTarget = irun.target === cid;
              return (
                <span key={`${i}-${cid}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                  <span
                    className="badge"
                    style={{
                      fontWeight: 600,
                      background: isTarget ? 'var(--accent)' : i === 0 ? 'var(--c-surface-soft)' : undefined,
                      color: isTarget ? '#fff' : undefined,
                    }}
                  >
                    {it?.term ?? cid}
                  </span>
                  {i < irun.history.length - 1 && <span className="muted" style={{ fontSize: '0.7rem' }}>→</span>}
                </span>
              );
            })}
          </div>

          {irun.target && irun.refPath && (
            <>
              <div style={{ fontWeight: 600, marginTop: '0.4rem' }}>
                参考答案路径（最短 {refLen} 步）
              </div>
              <div className="row" style={{ gap: '0.25rem', flexWrap: 'wrap', margin: '0.3rem 0' }}>
                {irun.refPath.map((cid, i) => {
                  const it = itemOf(cid);
                  const isTarget = irun.target === cid;
                  return (
                    <span key={`${i}-${cid}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                      <span
                        className="badge"
                        style={{
                          fontWeight: 600,
                          background: isTarget ? 'var(--accent)' : 'var(--c-surface-soft)',
                          color: isTarget ? '#fff' : undefined,
                          border: '1px dashed var(--c-hairline)',
                        }}
                      >
                        {it?.term ?? cid}
                      </span>
                      {i < irun.refPath!.length - 1 && <span className="muted" style={{ fontSize: '0.7rem' }}>→</span>}
                    </span>
                  );
                })}
              </div>
            </>
          )}

          <div className="row" style={{ gap: '0.5rem', marginTop: '0.6rem' }}>
            <button className="primary" onClick={startInput}>再来一局</button>
            <button className="ghost" onClick={exitRun}>换一批范围</button>
          </div>
        </div>
      </div>
    );
  }

  // ============ 默写输入：作答屏 ============
  if (irun && !irunEnded) {
    const totalDone = irun.history.length - 1;
    const isOpen = irun.mode === 'open';
    const targetLen = irun.goal ?? 0;
    return (
      <div>
        <div className="row" style={{ marginBottom: '0.5rem' }}>
          <button className="ghost" onClick={exitRun}>← 返回</button>
          <span className="spacer" />
          <span className="muted">
            {isOpen ? `已走 ${totalDone} / ${targetLen} 步` : irun.target ? `距终点最短 ${distLeft ?? '?'} 跳` : ''}
          </span>
          <button className="ghost" onClick={undoStep} disabled={irun.history.length <= 1} style={{ fontSize: '0.8rem' }}>
            ↩ 回退一步
          </button>
          {!isOpen && irun.target && (
            <button className="ghost" onClick={giveUp} style={{ fontSize: '0.8rem', color: 'var(--danger)' }}>
              放弃
            </button>
          )}
        </div>

        {irun.target && iTargetItem && (
          <div className="card" style={{ padding: '0.5rem 0.8rem', marginBottom: '0.5rem', background: 'var(--c-surface-soft)' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>终点目标：</span>
            <b style={{ fontSize: '1.25rem', color: 'var(--accent)' }}>{iTargetItem.term}</b>
            {iTargetItem.chinese && <span className="muted" style={{ marginLeft: '0.4rem', fontSize: '0.9rem' }}>{iTargetItem.chinese}</span>}
            {!isOpen && distLeft != null && (
              <span className="muted" style={{ fontSize: '0.85rem', marginLeft: '0.5rem' }}>（还差约 {distLeft} 跳）</span>
            )}
          </div>
        )}

        {/* 已走链 */}
        <div className="row" style={{ gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem', alignItems: 'center' }}>
          {irun.history.map((cid, i) => {
            const it = itemOf(cid);
            const last = i === irun.history.length - 1;
            return (
              <span key={`${i}-${cid}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                <span
                  className="badge"
                  style={{
                    fontWeight: last ? 700 : 400,
                    background: last ? 'var(--accent)' : 'var(--c-surface-soft)',
                    color: last ? '#fff' : undefined,
                  }}
                >
                  {it?.term ?? cid}
                </span>
                {i < irun.history.length - 1 && <span className="muted" style={{ fontSize: '0.7rem' }}>→</span>}
              </span>
            );
          })}
        </div>

        <div className="card">
          <div className="muted" style={{ fontSize: '0.85rem' }}>当前概念</div>
          <h2 style={{ marginTop: '0.2rem', marginBottom: '0.1rem', color: 'var(--accent)' }}>{iCurItem?.term}</h2>
          {iCurItem?.chinese && <p className="muted" style={{ fontSize: '0.9rem' }}>{iCurItem.chinese}</p>}
          {iCurItem && <span className="badge">{iCurItem.paper}</span>}

          <div style={{ marginTop: '0.8rem', fontWeight: 600, fontSize: '0.95rem' }}>
            {inDeg >= 2
              ? <>输入一个与「{iCurItem?.term}」相连的概念（相邻或隔 1 个概念都算）：</>
              : <>输入一个与「{iCurItem?.term}」相邻的概念：</>}
          </div>

          <div className="row" style={{ marginTop: '0.6rem' }}>
            <input
              ref={inputRef}
              value={iText}
              onChange={(e) => setIText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); tryMove(); }
              }}
              placeholder={inDeg >= 2 ? '打出相连（1~2 度内）的概念名…' : '打出相邻的概念名…'}
              autoComplete="off"
              style={{ flex: 1, minWidth: 180 }}
            />
            <button className="primary" onClick={tryMove} disabled={!iText.trim()}>接上</button>
          </div>
          <div className="row" style={{ marginTop: '0.4rem' }}>
            <button className="ghost" style={{ fontSize: '0.85rem' }} onClick={showHint}>
              💡 不会？看提示
            </button>
            {hintCid && <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>
              提示：{itemOf(hintCid)?.term}
            </span>}
          </div>

          {iMsg && (
            <div className="card" style={{
              marginTop: '0.7rem', padding: '0.5rem 0.8rem',
              background: iMsg.kind === 'ok' ? 'var(--success-bg)' : 'var(--danger-bg)',
              borderColor: iMsg.kind === 'ok' ? 'var(--success)' : 'var(--danger)',
              fontSize: '0.9rem',
            }}>
              {iMsg.kind === 'ok' ? '✓ ' : '✗ '}{iMsg.text}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ============ 选择模式：结果屏 ============
  if (run && choiceDone) {
    return (
      <div>
        <h1>逻辑接龙 {betaTag}</h1>
        <div className="card center">
          <h2 style={{ marginBottom: '0.4rem' }}>
            {run.mode === 'target' && targetItem ? `🎉 抵达 ${targetItem.term}！` : '🎉 接龙完成！'}
          </h2>
          <p className="muted">答对 {score} / {choiceTotal} 步</p>
          <div className="row" style={{ justifyContent: 'center', gap: '0.3rem', flexWrap: 'wrap', margin: '0.8rem 0' }}>
            {run.path.map((cid, i) => {
              const it = itemOf(cid);
              const isTarget = run.target === cid;
              return (
                <span key={`${i}-${cid}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                  <span
                    className="badge"
                    style={{
                      fontWeight: 600,
                      background: isTarget ? 'var(--accent)' : i === 0 ? 'var(--c-surface-soft)' : undefined,
                      color: isTarget ? '#fff' : undefined,
                    }}
                  >
                    {it?.term ?? cid}
                  </span>
                  {i < run.path.length - 1 && <span className="muted" style={{ fontSize: '0.7rem' }}>→</span>}
                </span>
              );
            })}
          </div>
          <div className="row" style={{ justifyContent: 'center', gap: '0.5rem' }}>
            <button className="primary" onClick={start}>再来一局</button>
            <button className="ghost" onClick={exitRun}>换一批范围</button>
          </div>
        </div>
      </div>
    );
  }

  // ============ 选择模式：作答屏 ============
  if (run && !choiceDone) {
    const correctItem = correctCid ? itemOf(correctCid) : undefined;
    return (
      <div>
        <div className="row" style={{ marginBottom: '0.5rem' }}>
          <button className="ghost" onClick={exitRun}>← 返回</button>
          <span className="spacer" />
          <span className="muted">第 {stepIdx + 1} / {choiceTotal} 步</span>
          <span className="badge success">得分 {score}</span>
        </div>

        {run.mode === 'target' && targetItem && (
          <div className="card" style={{ padding: '0.5rem 0.8rem', marginBottom: '0.5rem', background: 'var(--c-surface-soft)' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>终点目标：</span>
            <b style={{ fontSize: '1.25rem', color: 'var(--accent)' }}>{targetItem.term}</b>
            {targetItem.chinese && <span className="muted" style={{ marginLeft: '0.4rem', fontSize: '0.9rem' }}>{targetItem.chinese}</span>}
          </div>
        )}

        {/* 已走链 */}
        <div className="row" style={{ gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem', alignItems: 'center' }}>
          {run.path.slice(0, stepIdx + 1).map((cid, i) => {
            const it = itemOf(cid);
            const last = i === stepIdx;
            return (
              <span key={`${i}-${cid}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                <span
                  className="badge"
                  style={{
                    fontWeight: last ? 700 : 400,
                    background: last ? 'var(--accent)' : 'var(--c-surface-soft)',
                    color: last ? '#fff' : undefined,
                  }}
                >
                  {it?.term ?? cid}
                </span>
                {i < stepIdx && <span className="muted" style={{ fontSize: '0.7rem' }}>→</span>}
              </span>
            );
          })}
          {chosen === null && <span className="muted" style={{ fontSize: '0.8rem', marginLeft: '0.2rem' }}>…下一步？</span>}
        </div>

        {/* 当前概念 */}
        <div className="card">
          <div className="muted" style={{ fontSize: '0.85rem' }}>当前概念</div>
          <h2 style={{ marginTop: '0.2rem', marginBottom: '0.1rem', color: 'var(--accent)' }}>{curItem?.term ?? cur}</h2>
          {curItem?.chinese && <p className="muted" style={{ fontSize: '0.9rem' }}>{curItem.chinese}</p>}
          {curItem && <span className="badge">{curItem.paper}</span>}

          <div style={{ marginTop: '0.8rem', fontWeight: 600, fontSize: '0.95rem' }}>
            与「{curItem?.term ?? cur}」相邻的下一个概念是？
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.6rem' }}>
            {options.map((cid) => {
              const it = itemOf(cid);
              const isCorrect = cid === correctCid;
              const isChosen = chosen === cid;
              let bg = 'var(--surface)';
              let border = 'var(--border)';
              if (chosen !== null) {
                if (isCorrect) { bg = 'var(--success-bg)'; border = 'var(--success)'; }
                else if (isChosen) { bg = 'var(--danger-bg)'; border = 'var(--danger)'; }
              }
              return (
                <button
                  key={cid}
                  disabled={chosen !== null}
                  onClick={() => answer(cid)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: chosen !== null ? 'default' : 'pointer',
                    background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: '0.5rem 0.7rem',
                    fontSize: '0.92rem', color: 'var(--c-ink)',
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{it?.term ?? cid}</span>
                  {it?.chinese && <span className="muted" style={{ marginLeft: '0.4rem', fontSize: '0.82rem' }}>{it.chinese}</span>}
                  {it && <span className="muted" style={{ marginLeft: '0.3rem', fontSize: '0.72rem' }}>{it.paper.replace('Paper ', 'P')}</span>}
                  {chosen !== null && isCorrect && <span style={{ float: 'right' }}>✓</span>}
                  {chosen !== null && isChosen && !isCorrect && <span style={{ float: 'right' }}>✗</span>}
                </button>
              );
            })}
          </div>

          {chosen !== null && (
            <div className="card" style={{
              marginTop: '0.8rem', padding: '0.6rem 0.8rem',
              background: chosen === correctCid ? 'var(--success-bg)' : 'var(--danger-bg)',
              borderColor: chosen === correctCid ? 'var(--success)' : 'var(--danger)',
            }}>
              <strong>{chosen === correctCid ? '✓ 接对了！' : '✗ 断链了'}</strong>
              <div style={{ fontSize: '0.9rem', marginTop: '0.2rem' }}>
                {chosen === correctCid ? (
                  <>接下来是「<b>{correctItem?.term}</b>」</>
                ) : (
                  <>「<b>{correctItem?.term}</b>」才是与「{curItem?.term}」相邻的概念。</>
                )}
              </div>
            </div>
          )}

          {chosen !== null && (
            <div className="row" style={{ marginTop: '0.7rem', justifyContent: 'flex-end' }}>
              <button className="primary" onClick={advance}>
                {stepIdx >= choiceTotal - 1 ? '查看结果' : '下一步 →'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
