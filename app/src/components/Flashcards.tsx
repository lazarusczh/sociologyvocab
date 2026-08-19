import { useState, useMemo, useCallback } from 'react';
import { useStore } from '../lib/store';
import { shuffle } from '../lib/shuffle';
import CategoryFilter from './CategoryFilter';
import type { VocabItem } from '../lib/types';

const MASTERY_LABELS = ['未学', '不熟', '熟悉', '掌握'];

export default function Flashcards() {
  const { vocab, progress, setItemMastery, categories } = useStore();
  const [cat, setCat] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('all');
  const [order, setOrder] = useState<VocabItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);

  const filtered = useMemo(
    () =>
      vocab.filter(
        (i) => (cat === 'all' || i.category === cat) && (typeFilter === 'all' || i.type === typeFilter),
      ),
    [vocab, cat, typeFilter],
  );

  const start = useCallback(() => {
    let pool = filtered;
    if (reviewOnly) {
      pool = filtered.filter((i) => (progress[i.id]?.mastery ?? 0) < 2);
    }
    setOrder(shuffle(pool));
    setIdx(0);
    setFlipped(false);
  }, [filtered, reviewOnly, progress]);

  const current = order[idx];

  const next = () => {
    setFlipped(false);
    setIdx((i) => Math.min(i + 1, order.length - 1));
  };
  const prev = () => {
    setFlipped(false);
    setIdx((i) => Math.max(i - 1, 0));
  };

  const rate = (mastery: number) => {
    if (current) {
      setItemMastery(current.id, mastery);
      setTimeout(next, 150);
    }
  };

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">🂠</div><p>请先导入词汇表</p></div>;
  }

  if (order.length === 0) {
    return (
      <div>
        <h1>闪卡记忆</h1>
        <CategoryFilter
          items={vocab}
          categories={categories}
          selected={cat}
          onSelect={setCat}
          typeFilter={typeFilter}
          onTypeChange={setTypeFilter}
        />
        <div className="card">
          <label className="row" style={{ marginBottom: '0.5rem' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={reviewOnly}
              onChange={(e) => setReviewOnly(e.target.checked)}
            />
            <span>仅复习未掌握的（不熟/未学）</span>
          </label>
          <button className="primary" onClick={start} disabled={filtered.length === 0}>
            开始（{reviewOnly ? filtered.filter((i) => (progress[i.id]?.mastery ?? 0) < 2).length : filtered.length} 张卡片）
          </button>
        </div>
      </div>
    );
  }

  const m = current ? (progress[current.id]?.mastery ?? 0) : 0;

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button className="ghost" onClick={() => setOrder([])}>← 返回</button>
        <span className="spacer" />
        <span className="muted">{idx + 1} / {order.length}</span>
      </div>

      {current ? (
        <>
          <div className="flashcard" style={{ borderColor: flipped ? 'var(--accent)' : 'var(--border)' }} onClick={() => setFlipped((f) => !f)}>
            {!flipped ? (
              <>
                <div className="term">{current.term}</div>
                {current.type === 'scholar' && current.theory && (
                  <div className="badge" style={{ marginTop: '0.5rem' }}>{current.theory}</div>
                )}
                <div className="hint">点击翻转查看释义</div>
              </>
            ) : (
              <>
                <div className="cn">{current.chinese || '（学者）'}</div>
                {current.chinese && <div className="term" style={{ fontSize: '1.1rem', marginTop: '0.3rem' }}>{current.term}</div>}
                {current.theory && current.type === 'scholar' && (
                  <div className="badge" style={{ marginTop: '0.4rem' }}>{current.theory}</div>
                )}
                <div className="def">{current.definition}</div>
                {current.notes && <div className="muted" style={{ fontSize: '0.85rem', marginTop: '0.4rem' }}>备注：{current.notes}</div>}
              </>
            )}
          </div>

          {flipped && (
            <div className="card" style={{ marginTop: '0.8rem' }}>
              <div className="muted" style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                当前掌握度：{MASTERY_LABELS[m]}
              </div>
              <div className="row">
                <button className={m === 1 ? 'primary' : ''} onClick={() => rate(1)}>不熟</button>
                <button className={m === 2 ? 'primary' : ''} onClick={() => rate(2)}>熟悉</button>
                <button className={m === 3 ? 'primary' : ''} onClick={() => rate(3)}>掌握</button>
                <span className="spacer" />
                <button onClick={next} disabled={idx >= order.length - 1}>下一张 →</button>
              </div>
            </div>
          )}

          {!flipped && (
            <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'space-between' }}>
              <button onClick={prev} disabled={idx === 0}>← 上一张</button>
              <button onClick={next} disabled={idx >= order.length - 1}>跳过 →</button>
            </div>
          )}
        </>
      ) : (
        <div className="card center">
          <h2>本轮完成！</h2>
          <button className="primary" onClick={start}>再来一轮</button>
        </div>
      )}
    </div>
  );
}
