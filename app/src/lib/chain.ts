// 逻辑接龙：基于概念关系网络（conceptGraph）的出题引擎
// 玩法（见《逻辑关系与应用.md》玩法一/二）：
//   open   ：仅起点模式——随机起点，沿相邻概念走固定步数
//   target ：起点+终点模式——随机起点，BFS 找 3~6 跳远的终点，沿最短路径逐跳到达
// 作答 = 选择题：展示当前概念，从其邻居中选对下一个；干扰项优先取「二度邻居」（相关但不相邻）
import type { VocabItem } from './types';
import { buildConceptGraph, type ConceptGraph } from './conceptGraph';
import { conceptIdOf } from './relationSuggest';
import { isCorrectAnswer } from './answers';
import { shuffle } from './shuffle';

export type ChainMode = 'open' | 'target';

export interface ChainRun {
  mode: ChainMode;
  path: string[]; // cid 序列，相邻两点在图上有边（open/target 共用答题骨架）
  target: string | null; // target 模式的终点 cid；open 为 null
}

const randOf = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** 仅用给定词条建图：relations 引用范围外的边会被自动丢弃，得到「范围内有效子图」 */
export const buildRangeGraph = (items: VocabItem[]): ConceptGraph => buildConceptGraph(items);

const degIn = (g: ConceptGraph, cid: string): number => g.neighbors.get(cid)?.length ?? 0;

/**
 * 仅起点模式：随机游走出一条 steps 跳的链（steps+1 个节点），
 * 不回跳已访问节点；死路即放弃本次、换起点重试。
 */
export function randomOpenPath(g: ConceptGraph, steps: number, attempts = 80): string[] | null {
  const cids = [...g.nodes.keys()];
  const branchy = cids.filter((c) => degIn(g, c) >= 2);
  const starters = (branchy.length ? branchy : cids.filter((c) => degIn(g, c) >= 1));
  if (starters.length === 0) return null;
  for (let t = 0; t < attempts; t++) {
    const path: string[] = [randOf(starters)];
    const seen = new Set(path);
    let cur = path[0];
    let complete = true;
    for (let i = 0; i < steps; i++) {
      const nexts = (g.neighbors.get(cur) ?? []).filter((n) => !seen.has(n));
      if (nexts.length === 0) {
        complete = false;
        break;
      }
      cur = randOf(nexts);
      path.push(cur);
      seen.add(cur);
    }
    if (complete) return path;
  }
  return null;
}

/** 起点+终点模式：随机起点 BFS，取距离 [minLen,maxLen] 的节点作终点，返回最短路径 */
export function randomTargetPath(
  g: ConceptGraph,
  minLen = 3,
  maxLen = 6,
  attempts = 80,
): { path: string[]; target: string } | null {
  const starters = [...g.nodes.keys()].filter((c) => degIn(g, c) >= 1);
  if (starters.length === 0) return null;
  for (let t = 0; t < attempts; t++) {
    const start = randOf(starters);
    const dist = new Map<string, number>([[start, 0]]);
    const prev = new Map<string, string>();
    const queue = [start];
    while (queue.length) {
      const c = queue.shift()!;
      const d = dist.get(c)!;
      if (d >= maxLen) continue;
      for (const nb of g.neighbors.get(c) ?? []) {
        if (dist.has(nb)) continue;
        dist.set(nb, d + 1);
        prev.set(nb, c);
        queue.push(nb);
      }
    }
    const pool = [...dist.entries()].filter(([, d]) => d >= minLen).map(([c]) => c);
    if (pool.length === 0) continue;
    const target = randOf(pool);
    const path: string[] = [target];
    let c: string | undefined = target;
    while (c !== undefined && prev.has(c)) {
      c = prev.get(c)!;
      path.push(c);
    }
    path.reverse();
    return { path, target };
  }
  return null;
}

/**
 * 出当前步的选项：正确下一跳 + 干扰项。
 * 干扰优先「二度邻居」（隔一跳相关但不直接相邻，更难排除），不足再从全部无关节点补；
 * 干扰不足时选项数自动减少。
 */
export function buildOptions(
  g: ConceptGraph,
  cids: string[],
  cur: string,
  correct: string,
  limit = 4,
): string[] {
  const nb = new Set(g.neighbors.get(cur) ?? []);
  const second = new Set<string>();
  for (const n of nb) {
    for (const n2 of g.neighbors.get(n) ?? []) {
      if (n2 !== cur && !nb.has(n2)) second.add(n2);
    }
  }
  const pool = cids.filter((c) => c !== cur && c !== correct && !nb.has(c));
  pool.sort((a, b) => Number(second.has(b)) - Number(second.has(a))); // 二度优先
  const wrongs = shuffle(pool).slice(0, Math.max(0, limit - 1));
  return shuffle([correct, ...wrongs]);
}

// ---- 默写输入模式助手 ----

/** 把学生输入解析成词库中的概念组（复用答案容错 isCorrectAnswer）；无匹配返回 null */
export function matchInputToCid(
  items: VocabItem[],
  input: string,
): { cid: string; item: VocabItem } | null {
  const q = input.trim();
  if (!q) return null;
  for (const it of items) {
    if (it.term === q || isCorrectAnswer(it, q)) return { cid: conceptIdOf(it), item: it };
  }
  return null;
}

/** 返回概念的一个随机邻居（供"看提示"），无可走邻居返回 null */
export function randomNeighbor(g: ConceptGraph, cid: string): string | null {
  const nb = g.neighbors.get(cid) ?? [];
  return nb.length ? nb[Math.floor(Math.random() * nb.length)] : null;
}

/** 无向 BFS 最短跳数（供 target 探索的距离提示）；不可达返回 null */
export function shortestDist(g: ConceptGraph, from: string, to: string): number | null {
  if (from === to) return 0;
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const c = queue.shift()!;
    const d = dist.get(c)!;
    for (const nb of g.neighbors.get(c) ?? []) {
      if (dist.has(nb)) continue;
      if (nb === to) return d + 1;
      dist.set(nb, d + 1);
      queue.push(nb);
    }
  }
  return null;
}
