import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { isCorrectAnswer, getAcceptableForms } from '../lib/answers';
import type { VocabItem } from '../lib/types';

// 开发后台：仅 developer 账号可见，用于指定词条测试答案判定（无需靠随机刷题）
export default function DevPanel() {
  const { vocab } = useStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<VocabItem | null>(null);
  const [testInput, setTestInput] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return vocab
      .filter((i) => i.term.toLowerCase().includes(q) || i.chinese.toLowerCase().includes(q))
      .slice(0, 50);
  }, [vocab, query]);

  const testResult = selected && testInput.trim() ? isCorrectAnswer(selected, testInput) : null;

  return (
    <div>
      <h1>开发后台</h1>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        仅 developer 账号可见。指定词条查看可接受写法，并直接测试某输入是否判对。
      </p>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <input
          type="text"
          placeholder="搜索术语名 / 中文…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() && (
          <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {results.length === 0 && <p className="muted">无匹配词条</p>}
            {results.map((i) => (
              <button
                key={i.id}
                className={selected?.id === i.id ? 'active' : ''}
                onClick={() => { setSelected(i); setTestInput(''); }}
              >
                {i.term}{i.chinese ? `（${i.chinese}）` : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="card">
          <h3>
            {selected.term}{' '}
            {selected.chinese && <span className="muted" style={{ fontSize: '0.9rem' }}>（{selected.chinese}）</span>}
          </h3>
          <p className="muted" style={{ fontSize: '0.85rem' }}>{selected.definition}</p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            {selected.paper}
            {selected.category ? ` / ${selected.category}` : ''}
            {selected.unit?.length ? ` / ${selected.unit.join('、')}` : ''}
          </p>

          <div style={{ marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>
              可接受写法（{getAcceptableForms(selected).length}，点击可填入下方测试）：
            </span>
            <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
              {getAcceptableForms(selected).map((f) => (
                <span key={f} className="badge" style={{ cursor: 'pointer' }} onClick={() => setTestInput(f)}>
                  {f}
                </span>
              ))}
            </div>
          </div>

          <div style={{ marginTop: '0.8rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>测试输入（判断是否判对）：</span>
            <div className="row" style={{ marginTop: '0.3rem', alignItems: 'center', gap: '0.5rem' }}>
              <input
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="输入要测试的写法…"
                style={{ flex: 1 }}
              />
              {testResult !== null && (
                <span className={testResult ? 'badge success' : 'badge'} style={{ whiteSpace: 'nowrap' }}>
                  {testResult ? '✓ 判对' : '✗ 判错'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
