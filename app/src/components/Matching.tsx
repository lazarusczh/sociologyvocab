import { useState, useMemo, useCallback } from 'react';
import { useStore } from '../lib/store';
import { sample, shuffle } from '../lib/shuffle';
import CategoryFilter from './CategoryFilter';
import type { VocabItem } from '../lib/types';

const PAIRS = 6;

export default function Matching() {
  const { vocab, recordItem, categories } = useStore();
  const [cat, setCat] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('all');
  const [left, setLeft] = useState<VocabItem[]>([]);
  const [right, setRight] = useState<VocabItem[]>([]);
  const [selLeft, setSelLeft] = useState<string | null>(null); // selected item id on left
  const [matched, setMatched] = useState<Set<string>>(new Set());
  const [wrongPair, setWrongPair] = useState<[string, string] | null>(null);
  const [mistakes, setMistakes] = useState(0);

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
    setMatched(new Set());
    setWrongPair(null);
    setMistakes(0);
  }, [filtered]);

  const clickRight = (rid: string) => {
    if (!selLeft) return;
    if (matched.has(rid)) return;
    if (selLeft === rid) {
      // 正确配对
      const next = new Set(matched);
      next.add(rid);
      setMatched(next);
      setSelLeft(null);
      recordItem(rid, true);
    } else {
      // 错误
      setWrongPair([selLeft, rid]);
      setMistakes((m) => m + 1);
      recordItem(rid, false);
      setTimeout(() => setWrongPair(null), 600);
      setSelLeft(null);
    }
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
          <p>将左侧术语与右侧释义配对。点击左侧术语，再点击右侧对应释义。每轮 {PAIRS} 对。</p>
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
                  onClick={() => setSelLeft(selected ? null : item.id)}
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
              const wrong = wrongPair?.[1] === item.id;
              return (
                <button
                  key={item.id}
                  className="option-btn"
                  disabled={done}
                  onClick={() => clickRight(item.id)}
                  style={{
                    opacity: done ? 0.4 : 1,
                    background: wrong ? 'var(--danger-bg)' : undefined,
                    borderColor: wrong ? 'var(--danger)' : undefined,
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
        {selLeft ? '已选择左侧术语，请点击右侧对应释义' : '点击左侧任一术语开始配对'}
      </p>
    </div>
  );
}
