import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useStore, useStudySession, useCelebrateCheckIn } from '../lib/store';
import { sample, shuffle } from '../lib/shuffle';
import { isCorrectAnswer, pickSpellingPrompt, type SpellingPrompt } from '../lib/answers';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';
import type { VocabItem } from '../lib/types';

const ROUND = 10;

export default function Spelling() {
  const { vocab, recordItem, papers, categories } = useStore();
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [units, setUnits] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('term');
  const [round, setRound] = useState<VocabItem[]>([]);
  // 与 round 同序的题干（中文 / 脱敏英文释义随机取一）：在 start() 时固化，避免重渲染时跳变
  const [prompts, setPrompts] = useState<SpellingPrompt[]>([]);
  const [idx, setIdx] = useState(0);
  const [input, setInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [correct, setCorrect] = useState<boolean | null>(null);
  const [score, setScore] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // 开始做题后才计时（筛选/准备阶段不计）
  useStudySession(round.length > 0);

  const onPaperChange = (p: string) => {
    setPaper(p);
    setCat('all');
    setUnits([]);
  };

  const onCatChange = (c: string) => {
    setCat(c);
    setUnits([]);
  };

  const filtered = useMemo(
    () => filterByPaperCat(vocab, paper, cat, units).filter((i) => typeFilter === 'all' || i.type === typeFilter),
    [vocab, paper, cat, units, typeFilter],
  );

  const start = useCallback(() => {
    const picked = shuffle(sample(filtered, Math.min(ROUND, filtered.length)));
    setRound(picked);
    setPrompts(picked.map((it) => pickSpellingPrompt(it)));
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

  useCelebrateCheckIn(round.length > 0 && !current);

  const submit = () => {
    if (revealed) return;
    const ok = isCorrectAnswer(current, input);
    setCorrect(ok);
    setRevealed(true);
    if (ok) setScore((s) => s + 1);
    recordItem(current.id, ok, 'spelling');
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
          <p>题干随机取中文释义或英文释义提示，拼写对应的英文术语。每轮 {ROUND} 题，大小写和标点不影响判分。</p>
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

  // 题干在 start() 时已固化；兜底仅用于热重载等极端情形
  const prompt = prompts[idx] ?? pickSpellingPrompt(current);

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button className="ghost" onClick={() => setRound([])}>← 返回</button>
        <span className="spacer" />
        <span className="muted">第 {idx + 1} / {round.length} 题</span>
        <span className="badge success">得分 {score}</span>
      </div>

      <div className="card">
        <div className="muted" style={{ fontSize: '0.85rem' }}>根据{prompt.label}拼写英文术语</div>
        {prompt.label === '中文' ? (
          <h2 style={{ color: 'var(--accent)' }}>{prompt.text}</h2>
        ) : (
          <p style={{ margin: '0.4rem 0', lineHeight: 1.5 }}>{prompt.text}</p>
        )}
        {!current.chinese && current.theory && (
          <div className="badge" style={{ margin: '0.3rem 0' }}>{current.theory}</div>
        )}

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
          <button className="ghost" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }} onClick={() => { setRevealed(true); setCorrect(false); recordItem(current.id, false, 'spelling'); }}>
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
