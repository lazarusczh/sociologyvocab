import {
  useState,
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type FormEvent as ReactFormEvent,
} from 'react';
import { useStore } from '../lib/store';
import CategoryFilter from './CategoryFilter';
import { generateCrossword, type GeneratedCrossword } from '../lib/crossword';

const MIN_CELL = 16;
const MAX_CELL = 30;

export default function Crossword() {
  const { vocab, categories } = useStore();
  const [cat, setCat] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('term');
  const [puzzle, setPuzzle] = useState<GeneratedCrossword | null>(null);
  const [user, setUser] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [checked, setChecked] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [msg, setMsg] = useState('');
  const [cellSize, setCellSize] = useState(MAX_CELL);
  const boardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = vocab.filter(
    (i) => (cat === 'all' || i.category === cat) && (typeFilter === 'all' || i.type === typeFilter),
  );

  const start = useCallback(() => {
    setMsg('');
    setChecked(false);
    setRevealed(false);
    setUser({});
    setSelected(null);
    const p = generateCrossword(filtered, 8);
    setPuzzle(p);
    if (!p) setMsg('当前词库中可用的单词太少，无法生成填字。请换个主题或类型。');
  }, [filtered]);

  // 根据可用宽度自适应格子尺寸，保证小屏也能完整显示
  useLayoutEffect(() => {
    if (!puzzle) return;
    const el = boardRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth;
      if (w > 0) {
        const size = Math.min(MAX_CELL, Math.max(MIN_CELL, Math.floor(w / puzzle.width)));
        setCellSize(size);
      }
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [puzzle]);

  function move(r: number, c: number, dr: number, dc: number) {
    if (!puzzle) return;
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < puzzle.height && nc >= 0 && nc < puzzle.width) {
      const cell = puzzle.grid[nr][nc];
      if (cell && !cell.blocked) {
        setSelected({ r: nr, c: nc });
        return;
      }
      nr += dr;
      nc += dc;
    }
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!selected || !puzzle) return;
    const { r, c } = selected;
    const cell = puzzle.grid[r]?.[c];
    if (!cell || cell.blocked) return;

    if (e.key === 'Backspace') {
      e.preventDefault();
      const cellKey = `${r},${c}`;
      setUser((prev) => {
        if (!prev[cellKey]) return prev;
        const next = { ...prev };
        delete next[cellKey];
        return next;
      });
      setChecked(false);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      move(r, c, 0, 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      move(r, c, 0, -1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(r, c, 1, 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(r, c, -1, 0);
    }
  };

  // 手机端通过隐藏输入框进入的字符（软键盘 input 事件比 keydown 更可靠）
  const handleInput = (e: ReactFormEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const ch = el.value.replace(/[^a-zA-Z]/g, '').slice(-1);
    el.value = '';
    if (!selected || !puzzle) return;
    const cell = puzzle.grid[selected.r]?.[selected.c];
    if (!cell || cell.blocked || !ch) return;
    setUser((prev) => ({ ...prev, [`${selected.r},${selected.c}`]: ch.toUpperCase() }));
    setChecked(false);
  };

  const selectCell = (r: number, c: number) => {
    setSelected({ r, c });
    inputRef.current?.focus();
  };

  const check = () => {
    setChecked(true);
    if (puzzle) {
      let allCorrect = true;
      for (const row of puzzle.grid)
        for (const cell of row) {
          if (!cell.blocked && (user[`${cell.row},${cell.col}`] || '') !== cell.letter) {
            allCorrect = false;
          }
        }
      setMsg(allCorrect ? '全部正确！' : '仍有错误，标红的格子需要修改。');
    }
  };

  const reveal = () => {
    if (!puzzle) return;
    const full: Record<string, string> = {};
    for (const row of puzzle.grid)
      for (const cell of row)
        if (!cell.blocked) full[`${cell.row},${cell.col}`] = cell.letter;
    setUser(full);
    setRevealed(true);
    setMsg('');
  };

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">⊞</div><p>请先导入词汇表</p></div>;
  }

  const across = puzzle?.clues.filter((c) => c.direction === 'across').sort((a, b) => a.number - b.number) ?? [];
  const down = puzzle?.clues.filter((c) => c.direction === 'down').sort((a, b) => a.number - b.number) ?? [];
  const gridStyle = { '--cw': `${cellSize}px` } as CSSProperties;
  const numFont = cellSize < 20 ? 6 : 8;

  return (
    <div>
      <h1>纵横填字</h1>

      {!puzzle && (
        <>
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
              从当前词库随机抽取术语生成填字游戏。术语中的空格会被省略（例如 “social control” 记为 “SOCIALCONTROL”），作为线索的答案。
            </p>
            <button className="primary" onClick={start}>生成填字</button>
          </div>
        </>
      )}

      {puzzle && (
        <>
          <div className="row" style={{ marginBottom: '0.5rem' }}>
            <button className="ghost" onClick={() => { setPuzzle(null); start(); }}>↻ 重新生成</button>
            <button className="ghost" onClick={() => setPuzzle(null)}>← 返回选择</button>
            <span className="spacer" />
            <button onClick={check}>检查</button>
            <button onClick={reveal}>显示答案</button>
          </div>

          {msg && (
            <div className={`card ${msg === '全部正确！' ? '' : ''}`} style={{
              marginBottom: '0.5rem',
              background: msg === '全部正确！' ? 'var(--success-bg)' : 'var(--warn-bg)',
              borderColor: msg === '全部正确！' ? 'var(--success)' : 'var(--warn)',
            }}>
              {msg}
            </div>
          )}

          <div className="cw-layout">
            <div ref={boardRef} className="cw-board">
              <input
                ref={inputRef}
                className="cw-hidden-input"
                type="text"
                inputMode="text"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={handleKeyDown}
                onInput={handleInput}
              />
              <div className="cw-grid" style={gridStyle}>
                {puzzle.grid.map((row, r) => (
                  <div className="cw-row" key={r}>
                    {row.map((cell, c) => {
                      const cellKey = `${r},${c}`;
                      if (cell.blocked) {
                        return <div className="cw-cell block" key={c} />;
                      }
                      const val = user[cellKey] || '';
                      const isSel = selected?.r === r && selected?.c === c;
                      const isWrong = checked && !revealed && val !== cell.letter;
                      const isRight = (revealed || (checked && val === cell.letter)) && val !== '';
                      return (
                        <div
                          key={c}
                          className={`cw-cell ${isSel ? 'selected' : ''}`}
                          onClick={() => selectCell(r, c)}
                          style={{
                            position: 'relative',
                            cursor: 'pointer',
                            background: isRight ? 'var(--success-bg)' : isWrong ? 'var(--danger-bg)' : undefined,
                            color: isWrong ? 'var(--danger)' : undefined,
                          }}
                        >
                          {cell.numbers.length > 0 && (
                            <span style={{ position: 'absolute', top: 1, left: 2, fontSize: numFont, lineHeight: 1 }}>
                              {cell.numbers[0]}
                            </span>
                          )}
                          {val}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="cw-clues">
              <h3 className="muted" style={{ fontSize: '0.9rem' }}>横向</h3>
              {across.map((cl) => (
                <div key={cl.number} style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                  <b>{cl.number}.</b> {cl.hint || cl.term} <span className="muted">({cl.answer.length}格)</span>
                </div>
              ))}
              <h3 className="muted" style={{ fontSize: '0.9rem', marginTop: '0.6rem' }}>纵向</h3>
              {down.map((cl) => (
                <div key={cl.number} style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                  <b>{cl.number}.</b> {cl.hint || cl.term} <span className="muted">({cl.answer.length}格)</span>
                </div>
              ))}
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.6rem' }}>
                点击格子后直接输入字母，用方向键（↑↓←→）选择下一个格子，退格键删除当前格。
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}