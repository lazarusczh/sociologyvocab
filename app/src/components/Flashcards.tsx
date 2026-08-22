import { useState, useMemo, useCallback } from 'react';
import { useStore } from '../lib/store';
import { shuffle } from '../lib/shuffle';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';
import type { VocabItem } from '../lib/types';

// 闪卡：纯自学浏览工具，不含掌握度评价
export default function Flashcards() {
  const { vocab, papers, categories } = useStore();
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [unit, setUnit] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('all');
  const [order, setOrder] = useState<VocabItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const filtered = useMemo(
    () => filterByPaperCat(vocab, paper, cat, unit).filter((i) => typeFilter === 'all' || i.type === typeFilter),
    [vocab, paper, cat, unit, typeFilter],
  );

  const onPaperChange = (p: string) => {
    setPaper(p);
    setCat('all');
    setUnit('all');
  };

  const onCatChange = (c: string) => {
    setCat(c);
    setUnit('all');
  };

  const start = useCallback(() => {
    setOrder(shuffle(filtered));
    setIdx(0);
    setFlipped(false);
  }, [filtered]);

  const current = order[idx];

  const next = () => {
    setFlipped(false);
    setIdx((i) => Math.min(i + 1, order.length - 1));
  };
  const prev = () => {
    setFlipped(false);
    setIdx((i) => Math.max(i - 1, 0));
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
          papers={papers}
          categories={categories}
          paper={paper}
          onPaperChange={onPaperChange}
          cat={cat}
          onCatChange={onCatChange}
          unit={unit}
          onUnitChange={setUnit}
          typeFilter={typeFilter}
          onTypeChange={setTypeFilter}
        />
        <div className="card">
          <button className="primary" onClick={start} disabled={filtered.length === 0}>
            开始（{filtered.length} 张卡片）
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button className="ghost" onClick={() => setOrder([])}>← 返回</button>
        <span className="spacer" />
        <span className="muted">{idx + 1} / {order.length}</span>
      </div>

      {current ? (
        <>
          <div
            className={`flashcard${flipped ? ' flipped' : ''}`}
            onClick={() => setFlipped((f) => !f)}
          >
            <div className="flashcard-inner">
              <div className="flashcard-face flashcard-front">
                <div className="term">{current.term}</div>
                {current.type === 'scholar' && current.theory && (
                  <div className="badge" style={{ marginTop: '0.5rem' }}>{current.theory}</div>
                )}
                <div className="hint">点击翻转查看释义</div>
              </div>
              <div className="flashcard-face flashcard-back">
                <div className="cn">{current.chinese || '（学者）'}</div>
                {current.chinese && (
                  <div className="term" style={{ fontSize: '1.1rem', marginTop: '0.3rem' }}>{current.term}</div>
                )}
                {current.theory && current.type === 'scholar' && (
                  <div className="badge" style={{ marginTop: '0.4rem' }}>{current.theory}</div>
                )}
                <div className="def">{current.definition}</div>
                {current.notes && (
                  <div className="muted" style={{ fontSize: '0.85rem', marginTop: '0.4rem' }}>备注：{current.notes}</div>
                )}
              </div>
            </div>
          </div>

          <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'space-between' }}>
            <button onClick={prev} disabled={idx === 0}>← 上一张</button>
            <button onClick={next} disabled={idx >= order.length - 1}>下一张 →</button>
          </div>
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