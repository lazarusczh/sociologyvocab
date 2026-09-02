import { useState, useMemo, useCallback } from 'react';
import { useStore, useStudySession, useCelebrateCheckIn } from '../lib/store';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';
import { conceptIdOf } from '../lib/relationSuggest';
import {
  buildRangeGraph, randomOpenPath, randomTargetPath, buildOptions,
  type ChainRun, type ChainMode,
} from '../lib/chain';
import type { VocabItem } from '../lib/types';

const OPEN_STEPS = 8; // 仅起点模式：预设接龙步数（8 跳 = 8 题）
const TARGET_MIN = 3; // 起点+终点模式：终点距起点最少跳数
const TARGET_MAX = 6; // 终点距起点最多跳数

export default function LogicChain() {
  const { vocab, recordItem, papers, categories } = useStore();
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [units, setUnits] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('term');
  const [mode, setMode] = useState<ChainMode>('open');
  const [run, setRun] = useState<ChainRun | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [genErr, setGenErr] = useState('');

  useStudySession(run !== null && stepIdx < run.path.length - 1);
  useCelebrateCheckIn(run !== null && stepIdx >= run.path.length - 1);

  const onPaperChange = (p: string) => { setPaper(p); setCat('all'); setUnits([]); };
  const onCatChange = (c: string) => { setCat(c); setUnits([]); };

  // 筛选 → 子图（relations 指向范围外的边自动丢弃，图中只含本范围概念）
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

  const start = () => {
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
  };

  const exitRun = () => { setRun(null); setChosen(null); setStepIdx(0); setScore(0); };

  const totalSteps = run ? run.path.length - 1 : 0;
  const cur = run && stepIdx < totalSteps ? run.path[stepIdx] : null;
  const curItem = cur ? itemOf(cur) : undefined;
  const correctCid = run && stepIdx < totalSteps ? run.path[stepIdx + 1] : null;
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

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">⇄</div><p>请先导入词汇表</p></div>;
  }

  // ===== 准备屏：说明 + 模式 + 筛选 =====
  if (!run) {
    return (
      <div>
        <h1>逻辑接龙</h1>
        <p className="muted" style={{ fontSize: '0.9rem' }}>
          概念之间有人工整理的逻辑关系（高于 / 低于 / 并列 / 相反）。接龙时，你要从当前概念走向一个
          <strong>与它相邻</strong>的下一个概念。
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
          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            {([
              ['open', `仅起点 · 走 ${OPEN_STEPS} 步`],
              ['target', `起点 → 终点（${TARGET_MIN}~${TARGET_MAX} 跳）`],
            ] as [ChainMode, string][]).map(([m, label]) => (
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
                {label}
              </button>
            ))}
          </div>
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
            {mode === 'open'
              ? `系统随机给一个起点，你沿相邻概念一路接下去，共走 ${OPEN_STEPS} 步。`
              : '系统给定起点和一个距离 3~6 跳的终点，你每步选一个相邻概念，抵达终点即通关（绕路也可以，只要不断链）。'}
          </p>
          {genErr && <p style={{ fontSize: '0.85rem', color: 'var(--danger)' }}>{genErr}</p>}
          <button
            className="primary"
            onClick={start}
            disabled={cids.length < 2}
            style={{ marginTop: '0.4rem' }}
          >
            {cids.length < 2 ? '当前范围可接概念不足' : '开始接龙'}
          </button>
        </div>
      </div>
    );
  }

  // ===== 结算屏 =====
  if (stepIdx >= totalSteps) {
    return (
      <div>
        <h1>逻辑接龙</h1>
        <div className="card center">
          <h2 style={{ marginBottom: '0.4rem' }}>
            {run.mode === 'target' && targetItem ? `🎉 抵达 ${targetItem.term}！` : '🎉 接龙完成！'}
          </h2>
          <p className="muted">答对 {score} / {totalSteps} 步</p>
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

  // ===== 答题屏 =====
  const correctItem = correctCid ? itemOf(correctCid) : undefined;
  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button className="ghost" onClick={exitRun}>← 返回</button>
        <span className="spacer" />
        <span className="muted">第 {stepIdx + 1} / {totalSteps} 步</span>
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
              {stepIdx >= totalSteps - 1 ? '查看结果' : '下一步 →'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
