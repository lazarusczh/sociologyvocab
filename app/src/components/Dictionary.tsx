import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { normalizeKey, scholarSurnames, getSearchableForms } from '../lib/answers';
import type { VocabItem } from '../lib/types';

// 词典：纯社会学词典检索工具，只做查询展示，不参与打卡与掌握度计算
export default function Dictionary() {
  const { vocab } = useStore();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'term' | 'scholar'>('term');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const qNorm = normalizeKey(q);
    const qRaw = q.toLowerCase();
    const scored: { item: VocabItem; score: number }[] = [];

    for (const item of vocab) {
      if (item.type !== typeFilter) continue;
      let best: number | null = null;
      for (const form of getSearchableForms(item)) {
        const norm = normalizeKey(form);
        const lower = form.toLowerCase();
        const prefix = (qNorm && norm.startsWith(qNorm)) || (qRaw && lower.startsWith(qRaw));
        const contain = (qNorm && norm.includes(qNorm)) || (qRaw && lower.includes(qRaw));
        if (prefix) {
          best = 0;
          break;
        }
        if (contain && best === null) best = 1;
      }
      // 释义关键词反查（低权重）：记得概念但想不起名字时，用释义里的关键词反查词条
      if (best === null && item.definition) {
        const defNorm = normalizeKey(item.definition);
        const defHit = (qNorm && defNorm.includes(qNorm)) || (qRaw && item.definition.toLowerCase().includes(qRaw));
        if (defHit) best = 2;
      }
      if (best !== null) scored.push({ item, score: best });
    }

    scored.sort((a, b) => a.score - b.score || a.item.term.localeCompare(b.item.term));
    return scored.map((s) => s.item);
  }, [vocab, query, typeFilter]);

  const toggle = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">🔍</div><p>请先导入词汇表</p></div>;
  }

  const searching = query.trim() !== '';

  return (
    <div>
      <h1>词典</h1>
      <input
        type="search"
        placeholder="输入英文术语、中文或学者姓氏…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      <div className="tag-filter" style={{ marginTop: '0.6rem' }}>
        {(['term', 'scholar'] as const).map((t) => (
          <button
            key={t}
            className={typeFilter === t ? 'active' : ''}
            onClick={() => setTypeFilter(t)}
          >
            {t === 'term' ? '术语' : '学者'}
          </button>
        ))}
      </div>

      {!searching ? (
        <div className="empty-state">
          <div className="big">🔍</div>
          <p>输入关键词开始检索</p>
        </div>
      ) : results.length === 0 ? (
        <div className="empty-state">
          <p>没有找到匹配的词条</p>
        </div>
      ) : (
        <div className="dict-list" style={{ marginTop: '1rem' }}>
          <div className="muted" style={{ fontSize: '0.85rem' }}>
            共 {results.length} 条结果，点击词条查看详情
          </div>
          {results.map((item) => (
            <ResultRow
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={() => toggle(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ResultRow({
  item,
  expanded,
  onToggle,
}: {
  item: VocabItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isScholar = item.type === 'scholar';
  const surnames = isScholar ? [...new Set(scholarSurnames(item.term))] : [];
  const units = item.unit ?? [];

  return (
    <div className="card dict-row" onClick={onToggle}>
      <div className="row" style={{ alignItems: 'center' }}>
        <div style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 0.5rem' }}>
          {isScholar ? (
            <>
              {surnames.length > 0 && <span className="dict-surname">{surnames.join(' · ')}</span>}
              <span className="dict-sub">{item.term}</span>
            </>
          ) : (
            <>
              <span className="dict-name">{item.term}</span>
              {item.chinese && <span className="dict-cn">{item.chinese}</span>}
            </>
          )}
        </div>
        <span className="spacer" />
        <span className="badge">{item.paper}</span>
        <span className="dict-caret" aria-hidden>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="dict-detail" onClick={(e) => e.stopPropagation()}>
          {isScholar && item.theory && (
            <span className="badge warn" style={{ display: 'inline-block', marginBottom: '0.4rem' }}>
              {item.theory}
            </span>
          )}
          {item.definition && <div>{item.definition}</div>}
          {item.notes && (
            <div className="muted" style={{ fontSize: '0.85rem', marginTop: '0.4rem' }}>
              备注：{item.notes}
            </div>
          )}
          {(item.paper || item.category || units.length > 0) && (
            <div className="row" style={{ flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.5rem' }}>
              {item.paper && <span className="badge">{item.paper}</span>}
              {item.category && <span className="badge">{item.category}</span>}
              {units.map((u) => <span key={u} className="badge">{u}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}