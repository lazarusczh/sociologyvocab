import { useState, useMemo, useCallback, useRef } from 'react';
import { useStore, useStudySession, useCelebrateCheckIn } from '../lib/store';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';
import { conceptIdOf } from '../lib/relationSuggest';
import {
  buildRangeGraph, randomOpenPath, randomTargetPath, buildOptions,
  matchInputToCid, randomNeighbor, shortestDist,
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
}

const betaTag = <span style={{ fontSize: '0.65rem', verticalAlign: 'super', color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.02em' }}>Beta</span>;

export default function LogicChain() {
  const { vocab, recordItem, papers, categories } = useStore();
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [units, setUnits] = useState<string[]>([]);
  // 逻辑网络含教师保留的学者，默认全部纳入（术语 + 学者）
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('all');
  const [kind, setKind] = useState<AnswerKind>('choice'); // 作答方式：选择 / 默写输入
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

  const onPaperChange = (p: string) => { setPaper(p); setCat('all'); setUnits([]); };
  const onCatChange = (c: string) => { setCat(c); setUnits([]); };

  const filtered = useMemo(
    () => filterByPaperCat(vocab, paper, cat, units).filter((i) => typeFilter === 'all' || i.type === typeFilter),
    [vocab, paper, cat, units, typeFilter],
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
  const inChoice = run !== null && !choiceDone;
  const inInput = irun !== null && !irunDone;
  useStudySession(inChoice || inInput);
  useCelebrateCheckIn(choiceDone || irunDone);

  // ===== 开始 =====
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
  };

  const startInput = () => {
    setGenErr('');
    let start: string;
    let target: string | null = null;
    if (mode === 'target') {
      const attempt = randomTargetPath(graph, TARGET_MIN, TARGET_MAX);
      if (!attempt) {
        setGenErr('这个范围内找不到合适的一对起点与终点，试试扩大范围再开始。');
        return;
      }
      start = attempt.path[0];
      target = attempt.target;
    } else {
      const starters = cids.filter((c) => (graph.neighbors.get(c) ?? []).length >= 2);
      const pool = starters.length ? starters : cids.filter((c) => (graph.neighbors.get(c) ?? []).length >= 1);
      if (pool.length === 0) {
        setGenErr('这个范围内能连起来的概念太少了，试试扩大范围再开始。');
        return;
      }
      start = pool[Math.floor(Math.random() * pool.length)];
    }
    setIrun({ mode, cur: start, target, goal: mode === 'open' ? OPEN_STEPS : null, history: [start] });
    setIText('');
    setIMsg(null);
    setHintCid(null);
    setRun(null);
  };

  const start = () => (kind === 'choice' ? startChoice() : startInput());

  const exitRun = () => {
    setRun(null); setIrun(null); setChosen(null); setStepIdx(0); setScore(0);
    setIText(''); setIMsg(null); setHintCid(null);
  };

  // ===== 选择模式：作答 =====
  const cur = inChoice && !choiceDone ? run!.path[stepIdx] : null;
  const curItem = cur ? itemOf(cur) : undefined;
  const correctCid = inChoice && !choiceDone ? run!.path[stepIdx + 1] : null;
  const targetItem = run?.target ? itemOf(run.target) : undefined;

  const options = useMemo(() => {
    if (!cur || !correctCid) return [] as string[];
    return buildOptions(graph, cids, cur, correctCid, 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, stepIdx, graph, cids, cur, correctCid]);

  const answer = (cid: string) => {
    if (chosen !== null || !curItem || !correctCid) return;
    const ok = cid === correctCid;
    setChosen(cid);
    if (ok) setScore((s) => s + 1);
    recordItem(curItem.id, ok, 'chain');
  };
  const advance = () => {
    setStepIdx((i) => i + 1);
    setChosen(null);
  };

  // ===== 默写输入模式：作答 =====
  const iCurItem = irun && !irunDone ? itemOf(irun.cur) : undefined;
  const iTargetItem = irun?.target ? itemOf(irun.target) : undefined;
  const distLeft = irun && irun.target ? shortestDist(graph, irun.cur, irun.target) : null;

  const tryMove = () => {
    if (!irun || irunDone) return;
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
    const nb = graph.neighbors.get(irun.cur) ?? [];
    if (!nb.includes(m.cid)) {
      setIMsg({ kind: 'warn', text: `「${m.item.term}」和「${iCurItem?.term}」不相邻，换一个相邻概念再试。` });
      return;
    }
    const prev = irun.history.length >= 2 ? irun.history[irun.history.length - 2] : null;
    if (irun.mode === 'open' && prev === m.cid) {
      setIMsg({ kind: 'warn', text: `刚从这个概念过来，不能立刻走回头路，换个方向。` });
      return;
    }
    // 走成功了
    if (iCurItem) recordItem(iCurItem.id, true, 'chain');
    setIrun({ ...irun, cur: m.cid, history: [...irun.history, m.cid] });
    setIText('');
    setIMsg(null);
    setHintCid(null);
    inputRef.current?.focus();
  };

  const showHint = () => {
    if (!irun || irunDone) return;
    const h = hintCid ?? randomNeighbor(graph, irun.cur);
    if (h) {
      if (hintCid === null && iCurItem) recordItem(iCurItem.id, false, 'chain'); // 首次看提示记一次答错
      setHintCid(h);
      setIMsg({ kind: 'ok', text: `提示：可以接「${itemOf(h)?.term ?? h}」` });
    } else {
      setIMsg({ kind: 'warn', text: '这里似乎没有可走的相邻概念。' });
    }
  };

  const undoStep = () => {
    if (!irun || irun.history.length <= 1) return;
    const history = irun.history.slice(0, -1);
    setIrun({ ...irun, cur: history[history.length - 1], history });
    setIText('');
    setIMsg(null);
    setHintCid(null);
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
          typeFilter={typeFilter}
          onTypeChange={setTypeFilter}
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
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
            {kind === 'choice'
              ? '四选一：从四个候选中选出与当前概念相邻的那个，答对即前进。'
              : mode === 'open'
                ? `默写输入：每步打出与当前概念相邻的概念名，共接 ${OPEN_STEPS} 步达成目标；答不出可看提示。`
                : '默写输入自由探索：从起点打相邻概念一路走下去，不设步数上限，摸索到终点即通关（可随时回退上一步，上方会显示距终点最短还有几跳）。'}
          </p>
          {genErr && <p style={{ fontSize: '0.85rem', color: 'var(--danger)' }}>{genErr}</p>}
          <button className="primary" onClick={start} disabled={cids.length < 2} style={{ marginTop: '0.4rem' }}>
            {cids.length < 2 ? '当前范围可接概念不足' : '开始接龙'}
          </button>
        </div>
      </div>
    );
  }

  // ============ 默写输入：结果屏 ============
  if (irun && irunDone) {
    const arrived = irun.mode === 'target';
    return (
      <div>
        <h1>逻辑接龙 {betaTag}</h1>
        <div className="card center">
          <h2 style={{ marginBottom: '0.4rem' }}>
            {arrived ? '🎉 到达终点！' : '🎉 达成目标步数！'}
          </h2>
          <p className="muted">
            {arrived
              ? (() => {
                  const best = irun.history.length - 1;
                  const min = distLeft != null ? (shortestDist(graph, irun.history[0], irun.target!) ?? best) : best;
                  return `你走了 ${best} 步到达「${iTargetItem?.term}」（最短约 ${min} 步）`;
                })()
              : `一共接了 ${irun.history.length - 1} 步`}
          </p>
          <div className="row" style={{ justifyContent: 'center', gap: '0.3rem', flexWrap: 'wrap', margin: '0.8rem 0' }}>
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
          <div className="row" style={{ justifyContent: 'center', gap: '0.5rem' }}>
            <button className="primary" onClick={startInput}>再来一局</button>
            <button className="ghost" onClick={exitRun}>换一批范围</button>
          </div>
        </div>
      </div>
    );
  }

  // ============ 默写输入：作答屏 ============
  if (irun) {
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
        </div>

        {irun.target && iTargetItem && (
          <div className="card" style={{ padding: '0.5rem 0.8rem', marginBottom: '0.5rem', background: 'var(--c-surface-soft)' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>终点目标：</span>
            <b style={{ fontSize: '0.95rem', color: 'var(--accent)' }}>{iTargetItem.term}</b>
            {iTargetItem.chinese && <span className="muted" style={{ marginLeft: '0.3rem', fontSize: '0.8rem' }}>{iTargetItem.chinese}</span>}
            {!isOpen && distLeft != null && (
              <span className="muted" style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>（还差约 {distLeft} 跳）</span>
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
            输入一个与「{iCurItem?.term}」相邻的概念：
          </div>

          <div className="row" style={{ marginTop: '0.6rem' }}>
            <input
              ref={inputRef}
              value={iText}
              onChange={(e) => setIText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); tryMove(); }
              }}
              placeholder="打出相邻的概念名…"
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
            <b style={{ fontSize: '0.95rem', color: 'var(--accent)' }}>{targetItem.term}</b>
            {targetItem.chinese && <span className="muted" style={{ marginLeft: '0.3rem', fontSize: '0.8rem' }}>{targetItem.chinese}</span>}
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
