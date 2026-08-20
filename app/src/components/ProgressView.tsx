import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { MASTERY_LABELS, masteryLevel } from '../lib/storage';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';

export default function ProgressView() {
  const { vocab, progress, resetProgress, papers, categories } = useStore();
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [filter, setFilter] = useState<'all' | 'unlearned' | 'mastered'>('all');

  const onPaperChange = (p: string) => {
    setPaper(p);
    setCat('all');
  };

  const scope = useMemo(() => filterByPaperCat(vocab, paper, cat), [vocab, paper, cat]);

  const stats = useMemo(() => {
    let unlearned = 0, mastered = 0;
    for (const it of scope) {
      const lv = masteryLevel(progress[it.id]?.mastery ?? 0);
      if (lv === 0) unlearned++;
      if (lv >= 3) mastered++;
    }
    return { total: scope.length, unlearned, mastered };
  }, [scope, progress]);

  const list = useMemo(() => {
    let items = scope;
    if (filter === 'unlearned') items = items.filter((i) => masteryLevel(progress[i.id]?.mastery ?? 0) === 0);
    if (filter === 'mastered') items = items.filter((i) => masteryLevel(progress[i.id]?.mastery ?? 0) >= 3);
    // 按掌握度 + 字母排序
    return [...items].sort((a, b) => {
      const ma = progress[a.id]?.mastery ?? 0;
      const mb = progress[b.id]?.mastery ?? 0;
      if (ma !== mb) return ma - mb;
      return a.term.localeCompare(b.term);
    });
  }, [scope, progress, filter]);

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">📊</div><p>请先导入词汇表</p></div>;
  }

  return (
    <div>
      <h1>学习进度</h1>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="grid cols-3">
          <div className="stat"><span className="num">{stats.total}</span><span className="label">词汇总数</span></div>
          <div className="stat"><span className="num">{stats.mastered}</span><span className="label">已掌握</span></div>
          <div className="stat"><span className="num">{stats.unlearned}</span><span className="label">待学习</span></div>
        </div>
        <div style={{ marginTop: '0.8rem' }}>
          <div className="row" style={{ marginBottom: '0.3rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>掌握率</span>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: '0.85rem' }}>
              {stats.total > 0 ? Math.round((stats.mastered / stats.total) * 100) : 0}%
            </span>
          </div>
          <div className="progress-bar">
            <div style={{ width: `${stats.total > 0 ? (stats.mastered / stats.total) * 100 : 0}%` }} />
          </div>
        </div>
      </div>

      <CategoryFilter
        items={vocab}
        papers={papers}
        categories={categories}
        paper={paper}
        onPaperChange={onPaperChange}
        cat={cat}
        onCatChange={setCat}
      />

      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ maxWidth: 160 }}>
          <option value="all">全部</option>
          <option value="unlearned">待学习</option>
          <option value="mastered">已掌握</option>
        </select>
        <span className="spacer" />
        <button
          className="danger"
          onClick={() => { if (confirm('确定重置所有学习进度？此操作不可撤销。')) resetProgress(); }}
        >
          重置进度
        </button>
      </div>

      <div className="card">
        <h3>词汇列表（{list.length}）</h3>
        {list.length === 0 ? (
          <p className="muted">当前筛选下没有词汇。</p>
        ) : (
          <div className="grid" style={{ gap: '0.3rem' }}>
            {list.map((it) => {
              const p = progress[it.id];
              const m = p?.mastery ?? 0;
              const lv = masteryLevel(m);
              return (
                <div key={it.id} className="row" style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, minWidth: 160 }}>
                    <strong>{it.term}</strong>
                    {it.type === 'scholar' && <span className="badge" style={{ marginLeft: '0.4rem' }}>学者</span>}
                    {it.chinese && <span className="muted" style={{ marginLeft: '0.5rem', fontSize: '0.85rem' }}>{it.chinese}</span>}
                  </span>
                  <span className={`badge ${lv >= 3 ? 'success' : lv === 1 ? 'warn' : ''}`}>
                    {m > 0 ? `${MASTERY_LABELS[lv]} ${m}` : MASTERY_LABELS[lv]}
                  </span>
                  {p && p.seenCount > 0 && (
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      {p.correctCount}/{p.seenCount}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}