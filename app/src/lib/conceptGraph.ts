// 概念层级图（层级骨架 + 派生同级）
// 设计（2026-09-02，详见《逻辑关系与应用.md》）：
//   - 存储层只保留 higher/lower 有向边（层级骨架），peer/contrast 显式边仅用于
//     「无共同父但仍同级」等需手标的情况。
//   - 同级由结构推导：共享同一父概念的兄弟节点自动视为同级（derivedPeers），
//     不落库、不产生 O(n²) 存储；历史数据加载即自动享受，无需回补。
//   - 层级深度：从根节点（无父）沿最长路径拓扑推导，供展示/玩法（接龙可上下层移动）。
//   - 环检测：higher/lower 构成 DAG 是层级推导的前提，检测并单独标记环内节点。
import type { VocabItem } from './types';
import { conceptIdOf } from './relationSuggest';

export interface ConceptNode {
  cid: string;
  type: VocabItem['type'];
  term: string;
  parents: string[];  // 父概念 cid（本概念低于它们）
  children: string[]; // 子概念 cid（本概念高于它们）
  depth: number;      // 层级深度（最长路径；-1 = 处于环中，深度不可靠）
  inCycle: boolean;
}

export interface ConceptGraph {
  nodes: Map<string, ConceptNode>;
  explicitPeers: [string, string][]; // 手动并列
  contrasts: [string, string][];     // 对立
  derivedPeers: [string, string][];  // 共享父推导的同级（不落库）
  cycles: string[][];                // 环（概念组序列，层级异常）
  neighbors: Map<string, string[]>;  // 全邻居（dir + 显式 + 派生 peer），供接龙/连线
}

const key = (a: string, b: string) => [a, b].sort().join('\u0001');

export function buildConceptGraph(vocab: VocabItem[]): ConceptGraph {
  const byId = new Map(vocab.map((i) => [i.id, i]));
  const cidOf = (id: string): string => {
    const it = byId.get(id);
    return it ? conceptIdOf(it) : '';
  };

  // ---- 1. 提取概念级关系（higher/lower 去重，方向按字段语义，矛盾取先出现）----
  const dir = new Map<string, { parent: string; child: string }>();
  const explicitPeers = new Map<string, [string, string]>();
  const contrasts = new Map<string, [string, string]>();

  for (const it of vocab) {
    const ca = conceptIdOf(it);
    // it.relations.higher：it 低于这些 → ca 是子，bid 是父
    for (const bid of it.relations?.higher ?? []) {
      const cb = cidOf(bid);
      if (!cb || ca === cb) continue;
      const k = key(ca, cb);
      if (!dir.has(k)) dir.set(k, { parent: cb, child: ca });
    }
    // it.relations.lower：it 高于这些 → ca 是父，bid 是子
    for (const bid of it.relations?.lower ?? []) {
      const cb = cidOf(bid);
      if (!cb || ca === cb) continue;
      const k = key(ca, cb);
      if (!dir.has(k)) dir.set(k, { parent: ca, child: cb });
    }
    for (const bid of it.relations?.peer ?? []) {
      const cb = cidOf(bid);
      if (!cb || ca === cb) continue;
      const k = key(ca, cb);
      if (!explicitPeers.has(k)) explicitPeers.set(k, [ca, cb]);
    }
    for (const bid of it.relations?.contrast ?? []) {
      const cb = cidOf(bid);
      if (!cb || ca === cb) continue;
      const k = key(ca, cb);
      if (!contrasts.has(k)) contrasts.set(k, [ca, cb]);
    }
  }

  // ---- 2. 节点初始化 + 父子关系 ----
  const nodes = new Map<string, ConceptNode>();
  const ensure = (cid: string): ConceptNode => {
    let n = nodes.get(cid);
    if (!n) {
      const it = vocab.find((i) => conceptIdOf(i) === cid);
      n = { cid, type: it?.type ?? 'term', term: it?.term ?? cid, parents: [], children: [], depth: -1, inCycle: false };
      nodes.set(cid, n);
    }
    return n;
  };
  for (const { parent, child } of dir.values()) {
    ensure(parent).children.push(child);
    ensure(child).parents.push(parent);
  }

  // ---- 3. 环检测（Kahn 拓扑）+ 层级深度（最长路径）----
  const indeg = new Map<string, number>();
  for (const cid of nodes.keys()) indeg.set(cid, nodes.get(cid)!.parents.length);
  const queue: string[] = [];
  for (const [cid, d] of indeg) if (d === 0) queue.push(cid);
  const topo: string[] = [];
  while (queue.length) {
    const cur = queue.pop()!;
    topo.push(cur);
    for (const child of nodes.get(cur)!.children) {
      const d = indeg.get(child)! - 1;
      indeg.set(child, d);
      if (d === 0) queue.push(child);
    }
  }
  const inTopo = new Set(topo);
  const cyclic = new Set<string>();
  for (const cid of nodes.keys()) if (!inTopo.has(cid)) cyclic.add(cid);

  // 环分组：环内节点按父子连通性聚合（一个环一组）
  const cycles: string[][] = [];
  const seenCycle = new Set<string>();
  for (const cid of cyclic) {
    if (seenCycle.has(cid)) continue;
    const comp: string[] = [];
    const q = [cid];
    seenCycle.add(cid);
    while (q.length) {
      const cur = q.pop()!;
      comp.push(cur);
      const n = nodes.get(cur)!;
      for (const nb of [...n.parents, ...n.children]) {
        if (cyclic.has(nb) && !seenCycle.has(nb)) {
          seenCycle.add(nb);
          q.push(nb);
        }
      }
    }
    cycles.push(comp);
    for (const c of comp) nodes.get(c)!.inCycle = true;
  }

  // 层级深度：拓扑序保证父先于子，DP 取最长路径
  const depth = new Map<string, number>();
  for (const cid of topo) {
    const node = nodes.get(cid)!;
    let d = 0;
    for (const p of node.parents) {
      const pd = depth.get(p);
      if (pd != null) d = Math.max(d, pd + 1);
    }
    depth.set(cid, d);
    node.depth = d;
  }

  // ---- 4. 派生同级（共享父的兄弟节点）----
  const contrastKeys = new Set(contrasts.keys());
  const peerKeys = new Set(explicitPeers.keys());
  const derived = new Map<string, [string, string]>();
  for (const node of nodes.values()) {
    if (node.children.length < 2) continue;
    const uniq = [...new Set(node.children)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const k = key(uniq[i], uniq[j]);
        if (contrastKeys.has(k)) continue; // 已标相反 → 不推导
        if (peerKeys.has(k) || derived.has(k)) continue;
        derived.set(k, [uniq[i], uniq[j]]);
      }
    }
  }

  // ---- 5. 全邻居（dir 双向 + 显式 peer/contrast + 派生 peer）----
  const neighbors = new Map<string, string[]>();
  const addNB = (a: string, b: string) => {
    if (a === b) return;
    const la = neighbors.get(a) ?? [];
    la.push(b);
    neighbors.set(a, la);
    const lb = neighbors.get(b) ?? [];
    lb.push(a);
    neighbors.set(b, lb);
  };
  for (const { parent, child } of dir.values()) addNB(parent, child);
  for (const [a, b] of explicitPeers.values()) addNB(a, b);
  for (const [a, b] of contrasts.values()) addNB(a, b);
  for (const [a, b] of derived.values()) addNB(a, b);

  return {
    nodes,
    explicitPeers: [...explicitPeers.values()],
    contrasts: [...contrasts.values()],
    derivedPeers: [...derived.values()],
    cycles,
    neighbors,
  };
}
