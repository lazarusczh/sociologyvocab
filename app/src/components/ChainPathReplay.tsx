import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Network, DataSet, type Node as VisNode, type Edge as VisEdge, type Options } from 'vis-network/standalone';
import type { ConceptGraph } from '../lib/conceptGraph';

// 接龙完成后的「路径回放」：把刚走过的一条链放回概念网络里，逐段点亮。
//
// 设计（2026-10-20 与教师定稿）：
//   · 观感取 B2 —— vis-network 画局部子图（路径 + 1 跳邻居），SVG 覆盖层画「跨层跳」的虚线弧与行进光点。
//   · 跨层跳的来源：输入模式可把可接范围放宽到 2 度（LogicChain 的 inDeg=2），
//     此时相邻两跳在图上**没有真实的边**。这里不补中间节点（学生并没有"经过"它），
//     而是画一条绕开的虚线弧表示"跨了一层"。
//   · 相机只在目标节点快出画面时才平移；弧线用 canvas 坐标存、每次重绘按当前视口重算 d，
//     所以平移/缩放后仍然贴住两端节点。
//   · 不做逐题对错着色：选择模式的路径是开局就定好的参考路径，错误只体现在分数上；
//     且现有数据没有逐步对错留痕（chosen 每步重置），要做得另加 boolean[]。

const MAX_NODES = 40;      // 局部子图上限（路径 + 1 跳邻居）
const MAX_PATH_NODES = 13; // 路径最多回放 13 个节点（12 段），超出只放末段
const STEP_MS = 320;       // 一段普通边的行进时长
const JUMP_MS = 460;       // 跨层弧线的行进时长
const CAMERA_MS = 320;     // 镜头平移时长
const JUMP_COLOR = '#F2994A';

type EdgeType = 'higher' | 'peer' | 'contrast' | 'transitive';
interface EdgeSpec { id: string; a: string; b: string; type: EdgeType }

const EDGE_COLOR: Record<EdgeType, string> = {
  higher: '#4361EE',
  peer: '#3AA65F',
  contrast: '#FF7A59',
  transitive: '#3AA65F',
};

const pairKey = (a: string, b: string) => [a, b].sort().join('\u0001');
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) * (2 - 2 * t) / 2);

/** 二次贝塞尔的控制点：沿两端连线的法线外推，让弧线绕开中间可能存在的节点 */
function arcControl(ax: number, ay: number, bx: number, by: number, side = 1, mult = 1) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.max(34, Math.min(90, len * 0.28)) * mult;
  return { x: (ax + bx) / 2 - (dy / len) * off * side, y: (ay + by) / 2 + (dx / len) * off * side };
}

/** 弧线离其它节点的最近距离（取若干个采样点，够判断"会不会压住节点"） */
function curveClearance(
  pa: { x: number; y: number },
  pb: { x: number; y: number },
  side: number,
  mult: number,
  others: { x: number; y: number }[],
) {
  if (others.length === 0) return Infinity;
  const c = arcControl(pa.x, pa.y, pb.x, pb.y, side, mult);
  let best = Infinity;
  for (let i = 1; i <= 8; i++) {
    const t = i / 9;
    const u = 1 - t;
    const x = u * u * pa.x + 2 * u * t * c.x + t * t * pb.x;
    const y = u * u * pa.y + 2 * u * t * c.y + t * t * pb.y;
    for (const o of others) best = Math.min(best, Math.hypot(x - o.x, y - o.y));
  }
  return best;
}

/** 选一条不压住其它节点的弯法：先试两侧，再加大外推；都不行就取更大的那一侧 */
function pickArcSide(pa: { x: number; y: number }, pb: { x: number; y: number }, others: { x: number; y: number }[]) {
  for (const side of [1, -1]) {
    for (const mult of [1, 1.6]) {
      if (curveClearance(pa, pb, side, mult, others) >= 26) return { side, mult };
    }
  }
  return { side: 1, mult: 1.6 };
}

export default function ChainPathReplay({ graph, path, height = 340, autoPlay = true }: {
  graph: ConceptGraph;
  path: string[];       // cid 序列（含起点）
  height?: number;
  autoPlay?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const netRef = useRef<Network | null>(null);
  const nodesRef = useRef<DataSet<VisNode> | null>(null);
  const edgesRef = useRef<DataSet<VisEdge> | null>(null);
  const edgeByPair = useRef<Map<string, { id: string; type: EdgeType }>>(new Map());
  const baseNodes = useRef<VisNode[]>([]);
  const baseEdges = useRef<VisEdge[]>([]);
  const palette = useRef({ primary: '#0064E0', ink: '#1C1E22', hairline: '#CED0D4', surface: '#FFFFFF' });
  const arcGroupRef = useRef<SVGGElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const arcsRef = useRef<{
    el: SVGPathElement;
    pa: { x: number; y: number };
    pb: { x: number; y: number };
    side: number;
    mult: number;
  }[]>([]);
  const rafRef = useRef(0);
  const runRef = useRef(0);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);

  // 路径过长只回放末段（输入模式的自由探索没有步数上限）
  const shown = useMemo(() => {
    const clean = path.filter(Boolean);
    if (clean.length <= MAX_PATH_NODES) return { cids: clean, folded: 0 };
    return { cids: clean.slice(-MAX_PATH_NODES), folded: clean.length - MAX_PATH_NODES };
  }, [path]);

  // 局部子图：路径节点 + 1 跳邻居（上限 MAX_NODES），以及它们之间的四类边
  const sub = useMemo(() => {
    const picked = new Set(shown.cids);
    for (const cid of shown.cids) {
      if (picked.size >= MAX_NODES) break;
      for (const nb of graph.neighbors.get(cid) ?? []) {
        if (picked.size >= MAX_NODES) break;
        if (graph.nodes.has(nb)) picked.add(nb);
      }
    }
    const edges: EdgeSpec[] = [];
    const seen = new Set<string>();
    const push = (a: string, b: string, type: EdgeType) => {
      if (!picked.has(a) || !picked.has(b) || a === b) return;
      const k = pairKey(a, b);
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ id: `e${edges.length}`, a, b, type });
    };
    for (const cid of picked) {
      const n = graph.nodes.get(cid);
      if (!n) continue;
      for (const ch of n.children) push(cid, ch, 'higher');
    }
    for (const [a, b] of graph.explicitPeers) push(a, b, 'peer');
    for (const [a, b] of graph.contrasts) push(a, b, 'contrast');
    for (const [a, b] of graph.transitivePeers) push(a, b, 'transitive');
    // 派生同级也要算：接龙的 neighbors 含派生同级，漏掉会出现「相邻却无连线」的段落
    for (const [a, b] of graph.derivedPeers) push(a, b, 'transitive');
    return { cids: [...picked], edges };
  }, [graph, shown.cids]);

  // 路径分段：哪一段是「跨层跳」（图上没有真实的边）
  const segments = useMemo(() => {
    const out: { a: string; b: string; jump: boolean }[] = [];
    for (let i = 1; i < shown.cids.length; i++) {
      const a = shown.cids[i - 1];
      const b = shown.cids[i];
      out.push({ a, b, jump: !(graph.neighbors.get(a) ?? []).includes(b) });
    }
    return out;
  }, [graph, shown.cids]);

  // 弧线用 canvas 坐标存，按当前视口重算 d —— 相机平移后仍然贴住两端
  const syncArcs = useCallback(() => {
    const net = netRef.current;
    if (!net) return;
    for (const arc of arcsRef.current) {
      const pa = net.canvasToDOM(arc.pa);
      const pb = net.canvasToDOM(arc.pb);
      const c = arcControl(pa.x, pa.y, pb.x, pb.y, arc.side, arc.mult);
      arc.el.setAttribute('d', `M ${pa.x} ${pa.y} Q ${c.x} ${c.y} ${pb.x} ${pb.y}`);
    }
  }, []);

  /** 画一条跨层弧线；返回弯法（side/mult），供行进光点沿同一条曲线走 */
  const addArc = useCallback((a: string, b: string): { side: number; mult: number } | null => {
    const net = netRef.current;
    const g = arcGroupRef.current;
    if (!net || !g) return null;
    const pos = net.getPositions([a, b]);
    if (!pos[a] || !pos[b]) return null;
    const pa = net.canvasToDOM(pos[a]);
    const pb = net.canvasToDOM(pos[b]);
    const others = sub.cids
      .filter((c) => c !== a && c !== b)
      .map((c) => {
        const p = net.getPositions([c])[c];
        return p ? net.canvasToDOM(p) : null;
      })
      .filter((p): p is { x: number; y: number } => !!p);
    const { side, mult } = pickArcSide(pa, pb, others);

    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('class', 'chain-arc');
    el.setAttribute('pathLength', '1');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', JUMP_COLOR);
    el.setAttribute('stroke-width', '2.5');
    el.setAttribute('stroke-linecap', 'round');
    // 虚线样式交给 .chain-arc（含行进动画），这里不写死 dasharray
    g.appendChild(el);
    arcsRef.current.push({ el, pa: pos[a], pb: pos[b], side, mult });
    syncArcs();
    return { side, mult };
  }, [syncArcs, sub.cids]);

  const clearArcs = useCallback(() => {
    const g = arcGroupRef.current;
    if (g) while (g.firstChild) g.removeChild(g.firstChild);
    arcsRef.current = [];
  }, []);

  const nodeStyle = useCallback((cid: string, kind: 'idle' | 'done' | 'current' | 'start' | 'end'): Partial<VisNode> => {
    const p = palette.current;
    const node = graph.nodes.get(cid);
    const label = node?.term ?? cid;
    if (kind === 'current') {
      return { id: cid, label, borderWidth: 3, color: { background: p.primary, border: p.primary }, font: { color: '#FFFFFF', size: 13 } };
    }
    if (kind === 'start' || kind === 'end') {
      return { id: cid, label, borderWidth: 3, color: { background: 'rgba(0,100,224,0.20)', border: p.primary }, font: { color: p.ink, size: 12 } };
    }
    if (kind === 'done') {
      return { id: cid, label, borderWidth: 2, color: { background: 'rgba(0,100,224,0.12)', border: p.primary }, font: { color: p.ink, size: 12 } };
    }
    return { id: cid, label, borderWidth: 1, color: { background: 'rgba(0,0,0,0.03)', border: p.hairline }, font: { color: 'rgba(28,30,34,0.45)', size: 12 } };
  }, [graph]);

  const brightEdge = useCallback((a: string, b: string) => {
    const hit = edgeByPair.current.get(pairKey(a, b));
    if (!hit) return null;
    return { id: hit.id, width: 3.5, color: { color: EDGE_COLOR[hit.type], opacity: 1 } };
  }, []);

  // 收尾镜头：把整条路径重新框进视野，给出"总体形状"
  const endShot = useCallback(() => {
    netRef.current?.fit({ nodes: shown.cids, animation: { duration: 420, easingFunction: 'easeInOutQuad' } });
  }, [shown.cids]);

  const finishAll = useCallback(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    if (!nodes || !edges) return;
    clearArcs();
    endShot();
    nodes.update(shown.cids.map((cid, i) =>
      nodeStyle(cid, i === 0 ? 'start' : i === shown.cids.length - 1 ? 'end' : 'done')));
    for (const s of segments) {
      if (s.jump) addArc(s.a, s.b);
      else {
        const e = brightEdge(s.a, s.b);
        if (e) edges.update(e);
      }
    }
  }, [shown.cids, segments, nodeStyle, brightEdge, addArc, clearArcs, endShot]);

  const resetStyles = useCallback(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    if (!nodes || !edges) return;
    clearArcs();
    nodes.update(baseNodes.current);
    edges.update(baseEdges.current);
  }, [clearArcs]);

  // ===== 初始化：建图 → 稳定 → 冻结物理 =====
  useEffect(() => {
    const el = boxRef.current;
    if (!el || sub.cids.length < 2) return;

    const cssVar = (name: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
    palette.current = {
      primary: cssVar('--c-primary', '#0064E0'),
      ink: cssVar('--c-ink', '#1C1E22'),
      hairline: cssVar('--c-hairline', '#CED0D4'),
      surface: cssVar('--c-surface', '#FFFFFF'),
    };

    const nodeItems: VisNode[] = sub.cids.map((cid) => nodeStyle(cid, 'idle') as VisNode);
    const edgeItems: VisEdge[] = sub.edges.map((e) => ({
      id: e.id,
      from: e.a,
      to: e.b,
      arrows: e.type === 'higher' ? 'to' : undefined,
      dashes: e.type !== 'higher',
      width: 1,
      color: { color: EDGE_COLOR[e.type], opacity: 0.16 },
    }));
    baseNodes.current = nodeItems;
    baseEdges.current = edgeItems;
    edgeByPair.current = new Map(sub.edges.map((e) => [pairKey(e.a, e.b), { id: e.id, type: e.type }]));

    const nodes = new DataSet<VisNode>(nodeItems.map((n) => ({ ...n })));
    const edges = new DataSet<VisEdge>(edgeItems.map((e) => ({ ...e })));
    const options: Options = {
      physics: { enabled: true, stabilization: { enabled: true, iterations: 200, fit: true } },
      nodes: { shape: 'box', margin: { top: 6, right: 8, bottom: 6, left: 8 }, font: { size: 12 }, widthConstraint: { maximum: 130 } },
      edges: { selectionWidth: 0 },
      // 回放是"看"，不是"编辑"：禁掉拖拽/缩放，弧线坐标才不会因为用户操作而错位
      interaction: { dragNodes: false, dragView: false, zoomView: false, hover: false },
    };
    const network = new Network(el, { nodes, edges }, options);
    netRef.current = network;
    nodesRef.current = nodes;
    edgesRef.current = edges;

    network.on('afterDrawing', syncArcs);

    let settled = false;
    const onSettled = () => {
      if (settled) return;
      settled = true;
      network.setOptions({ physics: { enabled: false } });
      const boxW = el.clientWidth;
      if (boxW > 0 && boxW < 520) {
        // 窄屏整体 fit 会把字缩到看不清：改为贴住起点、保持 1:1，回放时靠平移走完
        const startPos = network.getPositions([shown.cids[0]])[shown.cids[0]];
        if (startPos) network.moveTo({ position: startPos, scale: 1, animation: false });
      } else {
        network.fit({ nodes: shown.cids, animation: false });
      }
      syncArcs();
      setReady(true);
    };
    network.once('stabilizationIterationsDone', onSettled);
    // 兜底：某些环境该事件不触发（或节点太少没跑稳定过程）
    const timer = setTimeout(onSettled, 1500);

    return () => {
      clearTimeout(timer);
      runRef.current++;
      cancelAnimationFrame(rafRef.current);
      network.off('afterDrawing', syncArcs);
      network.destroy();
      netRef.current = null;
      nodesRef.current = null;
      edgesRef.current = null;
      arcsRef.current = [];
      setReady(false);
      setPlaying(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, shown.cids, nodeStyle, syncArcs]);

  // ===== 回放 =====
  const ensureVisible = useCallback(async (cid: string, token: number) => {
    const net = netRef.current;
    const el = boxRef.current;
    if (!net || !el) return;
    const pos = net.getPositions([cid])[cid];
    if (!pos) return;
    const p = net.canvasToDOM(pos);
    const w = el.clientWidth;
    const h = el.clientHeight;
    const m = 70;
    if (p.x >= m && p.x <= w - m && p.y >= m && p.y <= h - m) return;
    net.moveTo({
      position: pos,
      scale: Math.max(net.getScale(), 1),
      animation: { duration: CAMERA_MS, easingFunction: 'easeInOutQuad' },
    });
    await delay(CAMERA_MS + 40);
    if (token !== runRef.current) return;
    syncArcs();
  }, [syncArcs]);

  /** arc 为 null 表示相邻两跳（走直线）；否则沿 addArc 选定的那条弧线走 */
  const travel = useCallback(async (a: string, b: string, arc: { side: number; mult: number } | null, token: number) => {
    const net = netRef.current;
    const dot = dotRef.current;
    if (!net || !dot) return;
    const pos = net.getPositions([a, b]);
    if (!pos[a] || !pos[b]) return;
    const pa = net.canvasToDOM(pos[a]);
    const pb = net.canvasToDOM(pos[b]);
    const c = arc ? arcControl(pa.x, pa.y, pb.x, pb.y, arc.side, arc.mult) : null;
    const dur = arc ? JUMP_MS : STEP_MS;
    const t0 = performance.now();
    dot.setAttribute('opacity', '1');
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const tick = (now: number) => {
        if (token !== runRef.current) { finish(); return; }
        const t = Math.min(1, (now - t0) / dur);
        const e = easeInOut(t);
        let x: number;
        let y: number;
        if (c) {
          const u = 1 - e;
          x = u * u * pa.x + 2 * u * e * c.x + e * e * pb.x;
          y = u * u * pa.y + 2 * u * e * c.y + e * e * pb.y;
        } else {
          x = pa.x + (pb.x - pa.x) * e;
          y = pa.y + (pb.y - pa.y) * e;
        }
        dot.setAttribute('cx', String(x));
        dot.setAttribute('cy', String(y));
        if (t < 1) rafRef.current = requestAnimationFrame(tick);
        else finish();
      };
      rafRef.current = requestAnimationFrame(tick);
      // 兜底：切到后台标签页时 rAF 会被暂停，不能因此卡住整段回放
      setTimeout(finish, dur + 160);
    });
    dot.setAttribute('opacity', '0');
  }, []);

  const play = useCallback(async () => {
    if (!netRef.current) return;
    const token = ++runRef.current;
    setPlaying(true);
    resetStyles();
    await delay(120);
    if (token !== runRef.current) return;
    for (let i = 0; i < segments.length; i++) {
      if (token !== runRef.current) return;
      const s = segments[i];
      await ensureVisible(s.b, token);
      if (token !== runRef.current) return;
      // 跨层弧线先画，行进光点随后沿同一条曲线走完
      const arc = s.jump ? addArc(s.a, s.b) : null;
      await travel(s.a, s.b, arc, token);
      if (token !== runRef.current) return;
      if (!s.jump) {
        const e = brightEdge(s.a, s.b);
        if (e) edgesRef.current?.update(e);
      }
      nodesRef.current?.update(nodeStyle(s.b, i === segments.length - 1 ? 'end' : 'current'));
      if (i === 0) nodesRef.current?.update(nodeStyle(s.a, 'start'));
      else nodesRef.current?.update(nodeStyle(s.a, 'done'));
    }
    if (token === runRef.current) {
      nodesRef.current?.update(nodeStyle(shown.cids[shown.cids.length - 1], 'end'));
      endShot();
      setPlaying(false);
    }
  }, [segments, shown.cids, ensureVisible, travel, addArc, brightEdge, nodeStyle, resetStyles, endShot]);

  // 首帧自动播放一次；用户偏好减少动态效果时直接给终态
  useEffect(() => {
    if (!ready || !autoPlay) return;
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { finishAll(); return; }
    void play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const skip = () => {
    runRef.current++;      // 取消进行中的回放
    setPlaying(false);
    dotRef.current?.setAttribute('opacity', '0');
    cancelAnimationFrame(rafRef.current);
    finishAll();
  };

  if (shown.cids.length < 2) return null;

  return (
    <div style={{ marginTop: '0.8rem', borderTop: '1px solid var(--border)', paddingTop: '0.7rem' }}>
      <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '0.95rem' }}>你走过的路</strong>
        <span className="muted" style={{ fontSize: '0.78rem' }}>
          {shown.folded > 0 ? `前 ${shown.folded} 个概念已折叠 · ` : ''}
          {shown.cids.length - 1} 段
        </span>
        <span className="spacer" />
        {playing ? (
          <button className="ghost" onClick={skip} style={{ padding: '0.15rem 0.6rem', fontSize: '0.8rem' }}>跳过</button>
        ) : (
          <button className="ghost" onClick={() => void play()} style={{ padding: '0.15rem 0.6rem', fontSize: '0.8rem' }}>重播</button>
        )}
      </div>

      <div style={{ position: 'relative', height, marginTop: '0.4rem' }}>
        <div ref={boxRef} style={{ position: 'absolute', inset: 0 }} />
        <svg
          aria-hidden
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        >
          <g ref={arcGroupRef} />
          <circle ref={dotRef} r={5.5} cx={-20} cy={-20} fill={JUMP_COLOR} opacity={0} />
        </svg>
      </div>

      <p className="muted" style={{ fontSize: '0.75rem', marginTop: '0.35rem', marginBottom: 0 }}>
        蓝色箭头 = 高于（高到低）· 绿色虚线 = 并列 / 同级 · 红色虚线 = 相反 ·
        橙色弧 = 一次跨两层的跳（图上没有直接的边）
      </p>
    </div>
  );
}
