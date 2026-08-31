import {
  useState,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type FormEvent as ReactFormEvent,
} from 'react';
import { useStore, useStudySession, useCelebrateCheckIn } from '../lib/store';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';
import { generateCrossword, type GeneratedCrossword, type Clue } from '../lib/crossword';

const MIN_CELL = 16;
const MAX_CELL = 30;

export default function Crossword() {
  const { vocab, recordItem, papers, categories } = useStore();
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [unit, setUnit] = useState('all');
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
  // 记录上一次输入/删除字母的格子，用于交叉格方向判断
  const lastInputPos = useRef<{ r: number; c: number } | null>(null);
  const lastDeletePos = useRef<{ r: number; c: number } | null>(null);
  // 是否已按「显示答案」一次性结算过全部线索（避免重复计数）
  const settledRef = useRef(false);
  // 离开本局前的确认弹窗：null 表示不显示，'back'/'regenerate' 表示待执行的离开动作
  const [confirmLeave, setConfirmLeave] = useState<null | 'back' | 'regenerate'>(null);
  // 开始做题后才计时（筛选/准备阶段不计）
  useStudySession(puzzle != null);

  // 显示答案（本局结束）时触发一次「打卡成功」达标检查（达标才弹）
  useCelebrateCheckIn(revealed);

  const onPaperChange = (p: string) => {
    setPaper(p);
    setCat('all');
    setUnit('all');
  };

  const onCatChange = (c: string) => {
    setCat(c);
    setUnit('all');
  };

  const filtered = filterByPaperCat(vocab, paper, cat, unit).filter(
    (i) => typeFilter === 'all' || i.type === typeFilter,
  );

  const start = useCallback(() => {
    setMsg('');
    setChecked(false);
    setRevealed(false);
    setUser({});
    setSelected(null);
    lastInputPos.current = null;
    lastDeletePos.current = null;
    settledRef.current = false;
    const p = generateCrossword(filtered, 8);
    setPuzzle(p);
    if (!p) setMsg('当前词库中可用的单词太少，无法生成填字。请换个主题或类型。');
  }, [filtered]);

  // 每个格子所属单词的横/纵方向集合（用于自动推进判断：只属于一个词的格子才能沿该方向推进）
  const cellDirs = useMemo(() => {
    const map = new Map<string, Set<'across' | 'down'>>();
    if (!puzzle) return map;
    for (const cl of puzzle.clues) {
      for (let i = 0; i < cl.answer.length; i++) {
        const r = cl.direction === 'across' ? cl.row : cl.row + i;
        const c = cl.direction === 'across' ? cl.col + i : cl.col;
        const key = `${r},${c}`;
        let s = map.get(key);
        if (!s) {
          s = new Set();
          map.set(key, s);
        }
        s.add(cl.direction);
      }
    }
    return map;
  }, [puzzle]);

  // 每个格子所属 clue 的详细信息（方向 + 是否该词首字母），用于自动推进的方向判定
  const cellClues = useMemo(() => {
    const map = new Map<string, { direction: 'across' | 'down'; isStart: boolean }[]>();
    if (!puzzle) return map;
    for (const cl of puzzle.clues) {
      for (let i = 0; i < cl.answer.length; i++) {
        const r = cl.direction === 'across' ? cl.row : cl.row + i;
        const c = cl.direction === 'across' ? cl.col + i : cl.col;
        const key = `${r},${c}`;
        let arr = map.get(key);
        if (!arr) {
          arr = [];
          map.set(key, arr);
        }
        arr.push({ direction: cl.direction, isStart: i === 0 });
      }
    }
    return map;
  }, [puzzle]);

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
    // 手动方向键跳格视为重新开始一段输入，清空方向记忆
    lastInputPos.current = null;
    lastDeletePos.current = null;
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

  // 输入字母后自动推进方向判定：
  // - 只属于一个词：沿该词方向
  // - 交叉格：先依据「前一输入格」判断（同行→横，同列→纵）
  // - 前一输入格无法判断时，若该格恰好是其中一个词的首字母则沿该词方向
  // - 其余情况（同时是两个词的首字母，或两个词都是非首字母且无法判断）→ 停下让用户决定
  function autoAdvance(r: number, c: number) {
    if (!puzzle) return;
    const clues = cellClues.get(`${r},${c}`);
    let dir: 'across' | 'down' | null = null;
    if (!clues || clues.length === 0) return;
    if (clues.length === 1) {
      dir = clues[0].direction;
    } else {
      // 交叉格：先依据「前一输入格」判断用户正在填哪个词（同行→横，同列→纵）
      const last = lastInputPos.current;
      if (last && last.r === r && last.c !== c) {
        dir = 'across';
      } else if (last && last.c === c && last.r !== r) {
        dir = 'down';
      } else {
        // 前一输入格无法判断（直接点交叉格开始 / 方向键跳来）→ 用首字母猜测
        const starts = clues.filter((cl) => cl.isStart);
        if (starts.length === 1) {
          dir = starts[0].direction;
        }
        // starts.length === 0 或 2 → 保持 dir = null，停下让用户决定
      }
    }
    lastInputPos.current = { r, c };
    if (!dir) return;
    const dr = dir === 'down' ? 1 : 0;
    const dc = dir === 'across' ? 1 : 0;
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nr >= puzzle.height || nc < 0 || nc >= puzzle.width) return;
    const next = puzzle.grid[nr][nc];
    if (next && !next.blocked) setSelected({ r: nr, c: nc });
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!selected || !puzzle) return;
    const { r, c } = selected;
    const cell = puzzle.grid[r]?.[c];
    if (!cell || cell.blocked) return;

    if (e.key === 'Backspace') {
      e.preventDefault();
      const cellKey = `${r},${c}`;
      const hasVal = !!user[cellKey];
      // 先依据上一次删除记录决定退格方向（交叉格时用于判断往左还是往上）
      const dirs = cellDirs.get(cellKey);
      let dir: 'across' | 'down' | null = null;
      if (dirs && dirs.size === 1) {
        dir = dirs.values().next().value as 'across' | 'down';
      } else if (dirs && dirs.size >= 2) {
        // 交叉格退格方向判定：
        // - 当前格有值（连续删除中）→ 沿用「上次删除的格子」判断方向
        // - 当前格为空（刚输入完想退回改上一个字母）→ 改用「上次输入的格子」判断方向
        const ref = hasVal ? lastDeletePos.current : lastInputPos.current;
        if (ref && ref.r === r && ref.c !== c) dir = 'across';
        else if (ref && ref.c === c && ref.r !== r) dir = 'down';
      }
      // 删除当前格并记录位置
      if (hasVal) {
        setUser((prev) => {
          const next = { ...prev };
          delete next[cellKey];
          return next;
        });
        lastDeletePos.current = { r, c };
      }
      setChecked(false);
      // 自动退格到上一个格子
      if (dir) {
        const dr = dir === 'down' ? -1 : 0;
        const dc = dir === 'across' ? -1 : 0;
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < puzzle.height && nc >= 0 && nc < puzzle.width) {
          const target = puzzle.grid[nr][nc];
          if (target && !target.blocked) setSelected({ r: nr, c: nc });
        }
      }
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
    autoAdvance(selected.r, selected.c);
  };

  const selectCell = (r: number, c: number) => {
    lastInputPos.current = null;
    lastDeletePos.current = null;
    setSelected({ r, c });
    inputRef.current?.focus();
  };

  // 判断某条线索的所有格子是否都已填对
  const clueIsCorrect = (cl: Clue): boolean => {
    if (!puzzle) return false;
    for (let i = 0; i < cl.answer.length; i++) {
      const r = cl.direction === 'across' ? cl.row : cl.row + i;
      const c = cl.direction === 'across' ? cl.col + i : cl.col;
      if ((user[`${r},${c}`] || '') !== cl.answer[i]) return false;
    }
    return true;
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
    // 一次性结算全部线索（在覆盖答案前按学生当前填写判定对错），只结算一次
    if (!settledRef.current) {
      settledRef.current = true;
      for (const cl of puzzle.clues) {
        if (cl.id) recordItem(cl.id, clueIsCorrect(cl), 'crossword');
      }
    }
    const full: Record<string, string> = {};
    for (const row of puzzle.grid)
      for (const cell of row)
        if (!cell.blocked) full[`${cell.row},${cell.col}`] = cell.letter;
    setUser(full);
    setRevealed(true);
    setMsg('');
  };

  // 离开本局（返回选择 / 重新生成）：已结算则直接离开，未结算则弹确认
  const doLeave = (action: 'back' | 'regenerate') => {
    setConfirmLeave(null);
    if (action === 'regenerate') {
      setPuzzle(null);
      start();
    } else {
      setPuzzle(null);
    }
  };

  const leaveOrConfirm = (action: 'back' | 'regenerate') => {
    if (settledRef.current) {
      doLeave(action);
    } else {
      setConfirmLeave(action);
    }
  };

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">⊞</div><p>请先导入词汇表</p></div>;
  }

  const across = puzzle?.clues.filter((c) => c.direction === 'across').sort((a, b) => a.number - b.number) ?? [];
  const down = puzzle?.clues.filter((c) => c.direction === 'down').sort((a, b) => a.number - b.number) ?? [];
  const gridStyle = { '--cw': `${cellSize}px` } as CSSProperties;
  const numFont = cellSize < 20 ? 6 : 8;

  // 每条线索随机选择中文或英文提示（有一方为空则用另一方），并在生成谜题期间保持不变
  const clueText = useMemo(() => {
    const map: Record<string, string> = {};
    if (!puzzle) return map;
    for (const cl of puzzle.clues) {
      const opts = [cl.zh, cl.en].filter((s) => s && s.trim().length > 0);
      const key = `${cl.direction}:${cl.row},${cl.col}`;
      map[key] = opts.length ? opts[Math.floor(Math.random() * opts.length)] : cl.term;
    }
    return map;
  }, [puzzle]);

  return (
    <div>
      <h1>纵横填字</h1>

      {!puzzle && (
        <>
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
            <button className="ghost" onClick={() => leaveOrConfirm('regenerate')}>↻ 重新生成</button>
            <button className="ghost" onClick={() => leaveOrConfirm('back')}>← 返回选择</button>
            <span className="spacer" />
            <button onClick={check}>检查</button>
            <button onClick={reveal}>结算</button>
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
              {across.map((cl) => {
                const ck = `${cl.direction}:${cl.row},${cl.col}`;
                return (
                  <div key={ck} style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                    <b>{cl.number}.</b> {clueText[ck] || cl.term} <span className="muted">({cl.answer.length}格)</span>
                  </div>
                );
              })}
              <h3 className="muted" style={{ fontSize: '0.9rem', marginTop: '0.6rem' }}>纵向</h3>
              {down.map((cl) => {
                const ck = `${cl.direction}:${cl.row},${cl.col}`;
                return (
                  <div key={ck} style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
                    <b>{cl.number}.</b> {clueText[ck] || cl.term} <span className="muted">({cl.answer.length}格)</span>
                  </div>
                );
              })}
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.6rem' }}>
                点击格子后直接输入字母，输入后自动前进；退格键删除当前格并后退，方向键（↑↓←→）可手动跳格。
              </p>
            </div>
          </div>
        </>
      )}

      {confirmLeave && (
        <div className="celebration-overlay" onClick={() => setConfirmLeave(null)}>
          <div className="celebration-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="celebration-title">尚未结算</div>
            <div className="celebration-desc">
              本局填写结果还没有结算，现在离开将不会计入练习和错题本。确定要离开吗？
            </div>
            <div className="row" style={{ gap: '0.5rem', justifyContent: 'center', marginTop: '0.8rem' }}>
              <button className="ghost" onClick={() => setConfirmLeave(null)}>继续做题</button>
              <button className="primary" onClick={() => doLeave(confirmLeave)}>仍要离开</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}