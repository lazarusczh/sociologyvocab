import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useStore, useStudySession } from '../lib/store';
import { sample, shuffle } from '../lib/shuffle';
import { isCorrectAnswer, maskAnswer } from '../lib/answers';
import CategoryFilter from './CategoryFilter';
import type { VocabItem } from '../lib/types';

const ROUND = 10;

export default function Spelling() {
  const { vocab, recordItem, categories } = useStore();
  useStudySession();
  const [cat, setCat] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('term');
  const [round, setRound] = useState<VocabItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [correct, setCorrect] = useState<boolean | null>(null);
  const [score, setScore] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () =>
      vocab.filter(
        (i) => (cat === 'all' || i.category === cat) && (typeFilter === 'all' || i.type === typeFilter),
      ),
    [vocab, cat, typeFilter],
  );

  const start = useCallback(() => {
    setRound(shuffle(sample(filtered, Math.min(ROUND, filtered.length))));
    setIdx(0);
    setInput('');
    setRevealed(false);
    setCorrect(null);
    setScore(0);
  }, [filtered]);

  const current = round[idx];

  useEffect(() => {
    if (current && !revealed) inputRef.current?.focus();
  }, [current, revealed, idx]);

  const submit = () => {
    if (revealed) return;
    const ok = isCorrectAnswer(current, input);
    setCorrect(ok);
    setRevealed(true);
    if (ok) setScore((s) => s + 1);
    recordItem(current.id, ok);
  };

  const next = () => {
    setIdx((i) => i + 1);
    setInput('');
    setRevealed(false);
    setCorrect(null);
  };

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">✎</div><p>请先导入词汇表</p></div>;
  }

  if (round.length === 0) {
    return (
      <div>
        <h1>拼写默写</h1>
        <CategoryFilter
          items={vocab}
          categories={categories}
          selected={cat}
          onSelect={setCat}
          typeFilter={typeFilter}
          onTypeChange={setTypeFilter}
        />
        <div className="card">
          <p>看中文释义（或英文释义提示）拼写英文术语。每轮 {ROUND} 题，大小写和标点不影响判分。</p>
          <button className="primary" onClick={start} disabled={filtered.length === 0}>
            开始默写
          </button>
        </div>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="card center">
        <h2>默写完成！</h2>
        <p className="muted">得分：{score} / {round.length}</p>
        <button className="primary" onClick={start}>再来一轮</button>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button className="ghost" onClick={() => setRound([])}>← 返回</button>
        <span className="spacer" />
        <span className="muted">第 {idx + 1} / {round.length} 题</span>
        <span className="badge success">得分 {score}</span>
      </div>

      <div className="card">
        <div className="muted" style={{ fontSize: '0.85rem' }}>请拼写对应的英文术语</div>
        {current.chinese && <h2 style={{ color: 'var(--accent)' }}>{current.chinese}</h2>}
        {!current.chinese && current.theory && (
          <div className="badge" style={{ margin: '0.3rem 0' }}>{current.theory}</div>
        )}
        <p className="muted" style={{ fontSize: '0.9rem' }}>释义提示：{maskAnswer(current, current.definition)}</p>

        <div className="row" style={{ marginTop: '0.8rem' }}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') revealed ? next() : submit();
            }}
            placeholder="输入英文术语…"
            disabled={revealed}
            style={{ flex: 1, minWidth: 200 }}
            autoComplete="off"
          />
          {!revealed ? (
            <button className="primary" onClick={submit} disabled={!input.trim()}>确认</button>
          ) : (
            <button className="primary" onClick={next}>
              {idx >= round.length - 1 ? '查看结果' : '下一题 →'}
            </button>
          )}
        </div>

        {!revealed && (
          <button className="ghost" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }} onClick={() => { setRevealed(true); setCorrect(false); recordItem(current.id, false); }}>
            不会，看答案
          </button>
        )}

        {revealed && (
          <div className={`card ${correct ? '' : ''}`} style={{
            marginTop: '0.8rem',
            background: correct ? 'var(--success-bg)' : 'var(--danger-bg)',
            borderColor: correct ? 'var(--success)' : 'var(--danger)',
          }}>
            <strong>{correct ? '✓ 正确' : '✗ 正确答案'}</strong>
            <div style={{ marginTop: '0.3rem' }}>
              <span className="term" style={{ fontWeight: 600 }}>{current.term}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
