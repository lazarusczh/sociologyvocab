import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { QuizQuestion } from '../lib/types';
import type { Clue } from '../lib/crossword';
import { crosswordCellKey, crosswordClueResults } from '../lib/quiz';

// 与独立练习页（Crossword.tsx）同一套网格外观；
// 这里刻意**不抽公共组件**：练习页自带「检查 / 结算 / 重新生成」与结算入账逻辑，
// 而测验这里只需要「填 + 交卷」，强行合并会把两套状态机耦在一起。
// 代价是网格输入逻辑（自动前进、退格、方向键）有两份实现，改动时需同步。
const MIN_CELL = 16;
const MAX_CELL = 30;

/** 逐格写入 / 清除一格字母；value 为 null 表示清空 */
export type CellChange = (key: string, value: string | null) => void;

export default function CrosswordAnswer({ q, answers, onChange, onNext, isLast, onSubmit }: {
  q: QuizQuestion;
  answers: Record<string, string | number>;
  onChange: CellChange;
  onNext: () => void;
  isLast: boolean;
  onSubmit: () => void;
}) {
  const puzzle = q.crossword;
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [cellSize, setCellSize] = useState(MAX_CELL);
  const boardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 记录上一次输入/删除的格子，用于交叉格判断「正在填横向还是纵向」
  const lastInputPos = useRef<{ r: number; c: number } | null>(null);
  const lastDeletePos = useRef<{ r: number; c: number } | null>(null);

  const clueList = puzzle?.clues ?? [];

  // 每条线索只取「中文提示」或「英文提示」其一，且整局保持不变（与练习页一致）
  const clueText = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cl of clueList) {
      const key = `${cl.direction}:${cl.row},${cl.col}`;
      const opts = [cl.zh, cl.en].filter((s) => s && s.trim().length > 0);
      // 两侧提示都为空时**不能**退回 cl.term —— 那就是答案本身，会直接泄题
      map[key] = opts.length ? opts[Math.floor(Math.random() * opts.length)] : '（本题无提示）';
    }
    return map;
  }, [clueList]);

  // 每个格子属于哪些线索（方向 + 是否首字母），用于输入后自动前进
  const cellClues = useMemo(() => {
    const map = new Map<string, { direction: 'across' | 'down'; isStart: boolean }[]>();
    for (const cl of clueList) {
      for (let i = 0; i < cl.answer.length; i++) {
        const r = cl.direction === 'across' ? cl.row : cl.row + i;
        const c = cl.direction === 'across' ? cl.col + i : cl.col;
        const key = `${r},${c}`;
        const arr = map.get(key) ?? [];
        arr.push({ direction: cl.direction, isStart: i === 0 });
        map.set(key, arr);
      }
    }
    return map;
  }, [clueList]);

  // 退格时判断方向用：格子所属的横/纵方向集合
  const cellDirs = useMemo(() => {
    const map = new Map<string, Set<'across' | 'down'>>();
    for (const cl of clueList) {
      for (let i = 0; i < cl.answer.length; i++) {
        const r = cl.direction === 'across' ? cl.row : cl.row + i;
        const c = cl.direction === 'across' ? cl.col + i : cl.col;
        const key = `${r},${c}`;
        const s = map.get(key) ?? new Set<'across' | 'down'>();
        s.add(cl.direction);
        map.set(key, s);
      }
    }
    return map;
  }, [clueList]);

  // 自适应格子尺寸：小屏也能整盘显示
  useLayoutEffect(() => {
    if (!puzzle) return;
    const el = boardRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth;
      if (w > 0) setCellSize(Math.min(MAX_CELL, Math.max(MIN_CELL, Math.floor(w / puzzle.width))));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [puzzle]);

  // 切题时清掉选中态
  useEffect(() => {
    setSelected(null);
    lastInputPos.current = null;
    lastDeletePos.current = null;
  }, [q.id]);

  if (!puzzle) return null;

  const keyOf = (r: number, c: number) => crosswordCellKey(q.id, r, c);
  const letterAt = (r: number, c: number) => String(answers[keyOf(r, c)] ?? '');

  function move(r: number, c: number, dr: number, dc: number) {
    if (!puzzle) return;
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

  function autoAdvance(r: number, c: number) {
    if (!puzzle) return;
    const clues = cellClues.get(`${r},${c}`);
    if (!clues || clues.length === 0) return;
    let dir: 'across' | 'down' | null = null;
    if (clues.length === 1) {
      dir = clues[0].direction;
    } else {
      const last = lastInputPos.current;
      if (last && last.r === r && last.c !== c) dir = 'across';
      else if (last && last.c === c && last.r !== r) dir = 'down';
      else {
        const starts = clues.filter((cl) => cl.isStart);
        if (starts.length === 1) dir = starts[0].direction;
      }
    }
    lastInputPos.current = { r, c };
    if (!dir) return;
    const nr = r + (dir === 'down' ? 1 : 0);
    const nc = c + (dir === 'across' ? 1 : 0);
    if (nr < 0 || nr >= puzzle.height || nc < 0 || nc >= puzzle.width) return;
    const next = puzzle.grid[nr][nc];
    if (next && !next.blocked) setSelected({ r: nr, c: nc });
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!selected) return;
    const { r, c } = selected;
    const cell = puzzle.grid[r]?.[c];
    if (!cell || cell.blocked) return;

    if (e.key === 'Backspace') {
      e.preventDefault();
      const cellKey = `${r},${c}`;
      const hasVal = !!letterAt(r, c);
      const dirs = cellDirs.get(cellKey);
      let dir: 'across' | 'down' | null = null;
      if (dirs && dirs.size === 1) {
        dir = dirs.values().next().value as 'across' | 'down';
      } else if (dirs && dirs.size >= 2) {
        const ref = hasVal ? lastDeletePos.current : lastInputPos.current;
        if (ref && ref.r === r && ref.c !== c) dir = 'across';
        else if (ref && ref.c === c && ref.r !== r) dir = 'down';
      }
      if (hasVal) {
        onChange(keyOf(r, c), null);
        lastDeletePos.current = { r, c };
      }
      if (dir) {
        const nr = r + (dir === 'down' ? -1 : 0);
        const nc = c + (dir === 'across' ? -1 : 0);
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

  // 手机端走 input 事件（软键盘比 keydown 可靠）
  const handleInput = (e: ReactFormEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const ch = el.value.replace(/[^a-zA-Z]/g, '').slice(-1);
    el.value = '';
    if (!selected) return;
    const cell = puzzle.grid[selected.r]?.[selected.c];
    if (!cell || cell.blocked || !ch) return;
    onChange(keyOf(selected.r, selected.c), ch.toUpperCase());
    autoAdvance(selected.r, selected.c);
  };

  const selectCell = (r: number, c: number) => {
    lastInputPos.current = null;
    lastDeletePos.current = null;
    setSelected({ r, c });
    inputRef.current?.focus();
  };

  const across = clueList.filter((c) => c.direction === 'across').sort((a, b) => a.number - b.number);
  const down = clueList.filter((c) => c.direction === 'down').sort((a, b) => a.number - b.number);
  const gridStyle = { '--cw': `${cellSize}px` } as CSSProperties;
  const numFont = cellSize < 20 ? 6 : 8;

  // 「已填完的词数」：只看是否填满，不泄露对错
  const filledClues = clueList.filter((cl) => {
    for (let i = 0; i < cl.answer.length; i++) {
      const r = cl.direction === 'across' ? cl.row : cl.row + i;
      const c = cl.direction === 'across' ? cl.col + i : cl.col;
      if (!letterAt(r, c)) return false;
    }
    return true;
  }).length;

  return (
    <div>
      <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
        已填满 {filledClues}/{clueList.length} 个词。点格子后直接输入字母，输入后自动前进；
        退格键删除，方向键可跳格。术语含多个单词时连写（空格与连字符省略，例如 social control 写作 SOCIALCONTROL）。
      </p>

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
                  if (cell.blocked) return <div className="cw-cell block" key={c} />;
                  const isSel = selected?.r === r && selected?.c === c;
                  return (
                    <div
                      key={c}
                      className={`cw-cell ${isSel ? 'selected' : ''}`}
                      onClick={() => selectCell(r, c)}
                      style={{ position: 'relative', cursor: 'pointer' }}
                    >
                      {cell.numbers.length > 0 && (
                        <span style={{ position: 'absolute', top: 1, left: 2, fontSize: numFont, lineHeight: 1 }}>
                          {cell.numbers[0]}
                        </span>
                      )}
                      {letterAt(r, c)}
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
            <div key={`a${cl.number}`} style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              <b>{cl.number}.</b> {clueText[`${cl.direction}:${cl.row},${cl.col}`] || cl.term}
              <span className="muted">（{cl.answer.length} 格）</span>
            </div>
          ))}
          <h3 className="muted" style={{ fontSize: '0.9rem', marginTop: '0.6rem' }}>纵向</h3>
          {down.map((cl) => (
            <div key={`d${cl.number}`} style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              <b>{cl.number}.</b> {clueText[`${cl.direction}:${cl.row},${cl.col}`] || cl.term}
              <span className="muted">（{cl.answer.length} 格）</span>
            </div>
          ))}
        </div>
      </div>

      <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
        <button className="primary" onClick={() => (isLast ? onSubmit() : onNext())}>
          {isLast ? '交卷' : '下一题 →'}
        </button>
      </div>
    </div>
  );
}

/** 答卷详情 / 教师端详情里的填字块结果（逐词列出，与判分同一口径） */
export function CrosswordClueResults({ q, answers }: {
  q: QuizQuestion;
  answers: Record<string, string | number>;
}) {
  const rows = crosswordClueResults(q, answers);
  if (rows.length === 0) return null;
  const correct = rows.filter((r) => r.correct).length;
  return (
    <div style={{ marginTop: '0.3rem', fontSize: '0.85rem' }}>
      <div className="muted" style={{ marginBottom: '0.2rem' }}>
        填字逐词结果：{correct}/{rows.length}
      </div>
      {rows.map(({ clue, input, correct: ok }: { clue: Clue; input: string; correct: boolean }) => (
        <div key={`${clue.direction}${clue.number}`} style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span className="muted" style={{ minWidth: '3.2rem' }}>
            {clue.number}{clue.direction === 'across' ? '横' : '纵'}
          </span>
          <span style={{ fontWeight: 600 }}>{clue.term}</span>
          <span style={{ color: ok ? 'var(--success)' : 'var(--danger)' }}>
            {input || '（未填完）'}
          </span>
          {!ok && <span className="muted">应为 {clue.answer}</span>}
        </div>
      ))}
    </div>
  );
}
