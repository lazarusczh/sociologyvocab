// 纵横填字生成算法
import { shuffle } from './shuffle';
import type { VocabItem } from './types';

export interface CrosswordCell {
  row: number;
  col: number;
  letter: string; // '' 表示空格
  numbers: number[]; // 线索编号（一个格子可属于横/纵）
  blocked: boolean;
}

export interface Clue {
  number: number;
  row: number;
  col: number;
  direction: 'across' | 'down';
  answer: string;
  term: string;
  zh: string; // 中文提示（术语的中文翻译；学者为空）
  en: string; // 英文提示（英文释义 / 学者理论描述）
}

export interface GeneratedCrossword {
  grid: CrosswordCell[][];
  clues: Clue[];
  height: number;
  width: number;
}

interface Placement {
  word: string;
  term: string;
  row: number;
  col: number;
  direction: 'across' | 'down';
}

// 从词库提取候选单词。注意：词组中的空格及连字符等非字母字符会被省略，
// 例如 "social control" -> "SOCIALCONTROL"，作为一个连续字母串参与填字。
function candidates(items: VocabItem[]): { word: string; term: string; zh: string; en: string }[] {
  const seen = new Set<string>();
  const out: { word: string; term: string; zh: string; en: string }[] = [];
  for (const it of items) {
    const word = it.term.toUpperCase().replace(/[^A-Z]/g, '');
    if (word.length < 3 || word.length > 16) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    const zh = it.chinese || '';
    const en = it.definition?.trim() || it.theory || '';
    out.push({ word, term: it.term, zh, en });
  }
  return out;
}

// 网格：用 Map 存储已放置字母
function makeGrid(placements: Placement[]): { cells: Map<string, string>; minR: number; maxR: number; minC: number; maxC: number } {
  const cells = new Map<string, string>();
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const p of placements) {
    for (let i = 0; i < p.word.length; i++) {
      const r = p.direction === 'across' ? p.row : p.row + i;
      const c = p.direction === 'across' ? p.col + i : p.col;
      cells.set(`${r},${c}`, p.word[i]);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minC = Math.min(minC, c); maxC = Math.max(maxC, c);
    }
  }
  return { cells, minR, maxR, minC, maxC };
}

function tryPlace(
  word: string,
  placements: Placement[],
): Placement | null {
  const { cells } = makeGrid(placements);
  if (placements.length === 0) {
    return { word, term: '', row: 0, col: 0, direction: 'across' };
  }

  // 遍历 word 的每个字符，寻找与已放置字符是相同字母的交叉点
  const attempts: Placement[] = [];
  for (let idx = 0; idx < word.length; idx++) {
    const ch = word[idx];
    for (const [key, cellCh] of cells) {
      if (cellCh !== ch) continue;
      const [r, c] = key.split(',').map(Number);
      // 尝试竖直放置（词向下），交叉点在第 idx 字符
      const startR = r - idx;
      const col = c;
      if (canPlace(word, startR, col, 'down', cells, r, c)) {
        attempts.push({ word, term: '', row: startR, col, direction: 'down' });
      }
      // 尝试水平放置，交叉点在第 idx 字符
      const startC = c - idx;
      const row = r;
      if (canPlace(word, row, startC, 'across', cells, r, c)) {
        attempts.push({ word, term: '', row, col: startC, direction: 'across' });
      }
    }
  }
  if (attempts.length === 0) return null;
  // 优先选与更多词交叉的放置（粗略：接近已有字母多的方向），这里随机选一个有效即可
  return attempts[Math.floor(Math.random() * attempts.length)];
}

function canPlace(
  word: string,
  startR: number,
  startC: number,
  direction: 'down' | 'across',
  cells: Map<string, string>,
  crossR: number,
  crossC: number,
): boolean {
  for (let i = 0; i < word.length; i++) {
    const r = direction === 'down' ? startR + i : startR;
    const c = direction === 'down' ? startC : startC + i;
    const key = `${r},${c}`;
    const existing = cells.get(key);
    // 若是交叉点，必须相同字母
    if (r === crossR && c === crossC) {
      if (existing !== word[i]) return false;
      continue;
    }
    if (existing !== undefined) return false; // 已有其他字母，冲突
    // 检查相邻格（上下左右），不允许旁边有相同方向的其他字母（避免粘连）
    if (direction === 'down') {
      if (cells.has(`${r},${c - 1}`) || cells.has(`${r},${c + 1}`)) return false;
    } else {
      if (cells.has(`${r - 1},${c}`) || cells.has(`${r + 1},${c}`)) return false;
    }
  }
  // 检查两端不能紧邻其他字母
  if (direction === 'down') {
    if (cells.has(`${startR - 1},${startC}`) || cells.has(`${startR + word.length},${startC}`)) return false;
  } else {
    if (cells.has(`${startR},${startC - 1}`) || cells.has(`${startR},${startC + word.length}`)) return false;
  }
  return true;
}

export function generateCrossword(items: VocabItem[], maxWords = 8): GeneratedCrossword | null {
  const cands = shuffle(candidates(items));
  if (cands.length === 0) return null;

  const placements: Placement[] = [
    { word: cands[0].word, term: cands[0].term, row: 0, col: 0, direction: 'across' },
  ];

  for (let i = 1; i < cands.length && placements.length < maxWords; i++) {
    const { word, term } = cands[i];
    const placed = tryPlace(word, placements);
    if (placed) {
      placements.push({ ...placed, term });
    }
  }

  const { cells, minR, maxR, minC, maxC } = makeGrid(placements);
  const height = maxR - minR + 1;
  const width = maxC - minC + 1;

  // 计算线索编号：先 across 后 down，按位置排序
  const numbered = new Map<string, number>();
  let num = 1;
  for (const p of placements) {
    const key = `${p.row},${p.col}`;
    if (!numbered.has(key)) {
      numbered.set(key, num);
      num++;
    }
  }

  const clues: Clue[] = placements.map((p) => {
    const n = numbered.get(`${p.row},${p.col}`)!;
    const cand = cands.find((c) => c.word === p.word);
    return {
      number: n,
      row: p.row - minR,
      col: p.col - minC,
      direction: p.direction,
      answer: p.word,
      zh: cand?.zh || '',
      en: cand?.en || '',
      term: p.term,
    };
  });

  // 构建网格
  const grid: CrosswordCell[][] = Array.from({ length: height }, (_, r) =>
    Array.from({ length: width }, (_, c) => {
      const key = `${r + minR},${c + minC}`;
      const letter = cells.get(key) || '';
      const nums: number[] = [];
      const n = numbered.get(key);
      if (n) nums.push(n);
      return {
        row: r,
        col: c,
        letter,
        numbers: nums,
        blocked: letter === '',
      };
    }),
  );

  return { grid, clues, height, width };
}