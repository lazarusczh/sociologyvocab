import { useState, useMemo, useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { useStore } from '../lib/store';
import { shuffle } from '../lib/shuffle';
import CategoryFilter from './CategoryFilter';

type CellState = 'correct' | 'present' | 'absent' | 'empty';

const MAX_GUESSES = 6;
const LONG_WORD_GUESSES = 10;

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z]/g, '');
}

function computeResult(guess: string, answer: string): CellState[] {
  const result: CellState[] = new Array(answer.length).fill('absent');
  const answerRemain = new Map<string, number>();

  // 第一遍：找 correct
  for (let i = 0; i < answer.length; i++) {
    if (guess[i] === answer[i]) {
      result[i] = 'correct';
    } else {
      answerRemain.set(answer[i], (answerRemain.get(answer[i]) || 0) + 1);
    }
  }
  // 第二遍：找 present
  for (let i = 0; i < answer.length; i++) {
    if (result[i] === 'correct') continue;
    const ch = guess[i];
    if (answerRemain.get(ch) && (answerRemain.get(ch) || 0) > 0) {
      result[i] = 'present';
      answerRemain.set(ch, (answerRemain.get(ch) || 0) - 1);
    }
  }
  return result;
}

interface Target {
  answer: string;
  term: string;
}

function getCandidates(term: string): Target | null {
  const answer = normalize(term);
  if (answer.length < 4 || answer.length > 9) return null;
  return { answer, term };
}

function pickTarget(items: Target[]): Target | null {
  const cands = shuffle(items);
  if (cands.length === 0) return null;
  return cands[0];
}

export default function Wordle() {
  const { vocab, categories } = useStore();
  const [cat, setCat] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('term');
  const [target, setTarget] = useState<Target | null>(null);
  const [guesses, setGuesses] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const candidates = useMemo(() => {
    const out: Target[] = [];
    const seen = new Set<string>();
    for (const it of vocab) {
      if (cat !== 'all' && it.category !== cat) continue;
      if (typeFilter !== 'all' && it.type !== typeFilter) continue;
      const c = getCandidates(it.term);
      if (c && !seen.has(c.answer)) {
        seen.add(c.answer);
        out.push(c);
      }
    }
    return out;
  }, [vocab, cat, typeFilter]);

  const start = useCallback(() => {
    const t = pickTarget(candidates);
    setTarget(t);
    setGuesses([]);
    setInput('');
    setMessage('');
  }, [candidates]);

  const maxGuesses = target ? (target.answer.length > 6 ? LONG_WORD_GUESSES : MAX_GUESSES) : MAX_GUESSES;
  const ended = target ? guesses.length >= maxGuesses || guesses.includes(target.answer) : false;

  const submit = () => {
    if (!target || ended) return;
    const g = normalize(input);
    if (g.length !== target.answer.length) {
      setMessage(`需要输入 ${target.answer.length} 个字母`);
      return;
    }
    setGuesses((prev) => [...prev, g]);
    setInput('');
    setMessage('');

    if (g === target.answer) {
      setMessage('🎉 猜对了！');
    } else if (guesses.length + 1 >= maxGuesses) {
      setMessage(`已用完机会，答案是 ${target.term}`);
    }
  };

  useEffect(() => {
    if (target && !ended) inputRef.current?.focus();
  }, [target, ended, guesses.length]);

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">▤</div><p>请先导入词汇表</p></div>;
  }

  if (!target) {
    return (
      <div>
        <h1>Wordle</h1>
        <CategoryFilter
          items={vocab}
          categories={categories}
          selected={cat}
          onSelect={setCat}
          typeFilter={typeFilter}
          onTypeChange={setTypeFilter}
        />
        <div className="card">
          <p className="muted">
            猜一个社会学术语（空格和连字符省略，如 “social control” → “SOCIALCONTROL”）。
            绿色=字母位置正确，黄色=字母存在但位置不对，灰色=无此字母。
            不超过 6 个字母的词有 {MAX_GUESSES} 次机会，更长词有 {LONG_WORD_GUESSES} 次机会。
          </p>
          <button className="primary" onClick={start} disabled={candidates.length === 0}>
            {candidates.length === 0 ? '当前筛选无可猜术语' : '开始游戏'}
          </button>
        </div>
      </div>
    );
  }

  const len = target.answer.length;

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button className="ghost" onClick={() => setTarget(null)}>← 返回选择</button>
        <button className="ghost" onClick={start}>↻ 换一题</button>
        <span className="spacer" />
        <span className="muted">{guesses.length}/{maxGuesses}</span>
      </div>

      <div className="card center">
        <div className="muted" style={{ fontSize: '0.9rem', marginBottom: '0.6rem' }}>
          共 {len} 个字母 · 剩余 {Math.max(0, maxGuesses - guesses.length)} 次机会
        </div>

        <div className="wordle-board" style={{ '--cols': len } as CSSProperties}>
          {guesses.map((g, gi) => {
            const res = computeResult(g, target.answer);
            return (
              <div className="wordle-row" key={gi}>
                {g.split('').map((ch, ci) => (
                  <div className={`wordle-cell ${res[ci]}`} key={ci}>{ch}</div>
                ))}
              </div>
            );
          })}
          {!ended && (
            <div className="wordle-row">
              {Array.from({ length: len }).map((_, ci) => (
                <div className="wordle-cell empty" key={ci} style={{ background: input[ci] ? 'var(--accent-bg)' : undefined }}>
                  {input[ci] || ''}
                </div>
              ))}
            </div>
          )}
        </div>

        {!ended && (
          <div className="row" style={{ justifyContent: 'center', marginTop: '1rem' }}>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, len))}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder={`输入 ${len} 个字母`}
              style={{ maxWidth: 'min(260px, 100%)', textAlign: 'center', letterSpacing: 2, textTransform: 'uppercase', fontSize: 16 }}
              autoComplete="off"
            />
            <button className="primary" onClick={submit}>提交</button>
          </div>
        )}

        {message && (
          <p style={{ marginTop: '0.8rem', fontWeight: 600, color: 'var(--accent)' }}>{message}</p>
        )}

        {ended && (
          <div style={{ marginTop: '1rem' }}>
            <p className="muted">正确答案：<strong>{target.term}</strong></p>
            <button className="primary" onClick={start}>再来一局</button>
          </div>
        )}
      </div>
    </div>
  );
}