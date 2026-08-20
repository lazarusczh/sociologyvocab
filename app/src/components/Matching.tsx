import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useStore, useStudySession } from '../lib/store';
import { sample, shuffle } from '../lib/shuffle';
import CategoryFilter from './CategoryFilter';
import type { VocabItem } from '../lib/types';

const PAIRS = 6;

export default function Matching() {
  const { vocab, recordItem, categories } = useStore();
  useStudySession();
  const [cat, setCat] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('all');
  const [left, setLeft] = useState<VocabItem[]>([]);
  const [right, setRight] = useState<VocabItem[]>([]);
  const [selLeft, setSelLeft] = useState<string | null>(null); // selected item id on left
  const [selRight, setSelRight] = useState<string | null>(null); // selected item id on right
  const [matched, setMatched] = useState<Set<string>>(new Set());
  const [wrongPair, setWrongPair] = useState<[string, string] | null>(null);
  const [mistakes, setMistakes] = useState(0);
  const timeoutRef = useRef<number | null>(null);

  const filtered = useMemo(
    () =>
      vocab.filter(
        (i) => (cat === 'all' || i.category === cat) && (typeFilter === 'all' || i.type === typeFilter),
      ),
    [vocab, cat, typeFilter],
  );

  const start = useCallback(() => {
    const pool = filtered.filter((i) => i.definition);
    const chosen = sample(pool, Math.min(PAIRS, pool.length));
    setLeft(shuffle(chosen));
    // 右侧用定义展示，打乱顺序
    setRight(shuffle(chosen));
    setSelLeft(null);
    setSelRight(null);
    setMatched(new Set());
    setWrongPair(null);
    setMistakes(0);
  }, [filtered]);

  // 无论先点左栏还是右栏，两侧都选中后即判定
  useEffect(() => {
    if (!selLeft || !selRight) return;
    if (selLeft === selRight) {
      setMatched((prev) => new Set(prev).add(selLeft));
      recordItem(selLeft, true);
    } else {
      setWrongPair([selLeft, selRight]);
      setMistakes((m) => m + 1);
      recordItem(selRight, false);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setWrongPair(null), 600);
    }
    setSelLeft(null);
    setSelRight(null);
  }, [selLeft, selRight, recordItem]);

  const clickLeft = (lid: string) => {
    if (matched.has(lid)) return;
    setSelLeft((prev) => (prev === lid ? null : lid));
  };

  const clickRight = (rid: string) => {
    if (matched.has(rid)) return;
    setSelRight((prev) => (prev === rid ? null : rid));
  };

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">⇄</div><p>请先导入词汇表</p></div>;
  }

  if (left.length === 0) {
    return (
      <div>
        <h1>匹配题</h1>
        <CategoryFilter
          items={vocab}
          categories={categories}
          selected={cat}
          onSelect={setCat}
          typeFilter={typeFilter}
          onTypeChange={setTypeFilter}
        />
        <div className="card">
          <p>将左侧术语与右侧释义配对，可从任意一侧开始选。每轮 {PAIRS} 对。</p>
          <button className="primary" onClick={start} disabled={filtered.length < 2}>
            开始匹配
          </button>
        </div>
      </div>
    );
  }

  if (matched.size === left.length) {
    return (
      <div className="card center">
        <h2>全部配对成功！</h2>
        <p className="muted">错误次数：{mistakes}</p>
        <button className="primary" onClick={start}>再来一轮</button>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button className="ghost" onClick={() => setLeft([])}>← 返回</button>
        <span className="spacer" />
        <span className="muted">已配对 {matched.size}/{left.length}</span>
        {mistakes > 0 && <span className="badge danger">错误 {mistakes}</span>}
      </div>

      <div className="grid cols-2">
        <div>
          <h3 className="muted">术语</h3>
          <div className="grid" style={{ gap: '0.4rem' }}>
            {left.map((item) => {
              const done = matched.has(item.id);
              const selected = selLeft === item.id;
              const wrong = wrongPair?.[0] === item.id;
              return (
                <button
                  key={item.id}
                  className="option-btn"
                  disabled={done}
                  onClick={() => clickLeft(item.id)}
                  style={{
                    opacity: done ? 0.4 : 1,
                    background: selected ? 'var(--accent-bg)' : wrong ? 'var(--danger-bg)' : undefined,
                    borderColor: selected ? 'var(--accent)' : wrong ? 'var(--danger)' : undefined,
                  }}
                >
                  <span>{item.term}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <h3 className="muted">释义</h3>
          <div className="grid" style={{ gap: '0.4rem' }}>
            {right.map((item) => {
              const done = matched.has(item.id);
              const selected = selRight === item.id;
              const wrong = wrongPair?.[1] === item.id;
              return (
                <button
                  key={item.id}
                  className="option-btn"
                  disabled={done}
                  onClick={() => clickRight(item.id)}
                  style={{
                    opacity: done ? 0.4 : 1,
                    background: wrong ? 'var(--danger-bg)' : selected ? 'var(--accent-bg)' : undefined,
                    borderColor: wrong ? 'var(--danger)' : selected ? 'var(--accent)' : undefined,
                    fontSize: '0.88rem',
                  }}
                >
                  <span>{item.definition}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
        {selLeft && !selRight
          ? '已选择左侧术语，请点击右侧对应释义'
          : selRight && !selLeft
          ? '已选择右侧释义，请点击左侧对应术语'
          : '点击左侧术语或右侧释义任一选项开始配对'}
      </p>
    </div>
  );
}
