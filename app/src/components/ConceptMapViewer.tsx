import { useEffect, useMemo, useRef, useState } from 'react';
import type { VocabItem } from '../lib/types';
import { Network, DataSet, type Node as VisNode, type Edge as VisEdge, type Options } from 'vis-network/standalone';
import { conceptIdOf } from '../lib/relationSuggest';
import { buildConceptGraph, type ConceptGraph } from '../lib/conceptGraph';

// 概念图谱查看器：节点 = 概念组，边 = 高于/并列/相反（+ 可选派生同级）。
// 供两处复用：
//   1. 教师后台「逻辑管理 → 关系网络」卡片（showToggle=true，可开关派生同级）
//   2. 学生/全体「资料 → 概念网络」页（showToggle=false，固定不显示派生同级——全开 3065 条边过密、卡顿）
// 交互：聚焦检索框（输入概念 → 1/2/3 度局部上下游）、可拖动/缩放、tooltip 显示连接数/层级/条目。
interface Props {
  vocab: VocabItem[];
  title?: string;                  // 卡片标题（默认「关系网络」）
  height?: number;                 // 画布高度 px（默认 420）
  showDerived?: boolean;           // 是否显示「派生同级」（共享父推导同级）边，受控；默认 false
  showToggle?: boolean;            // 是否在标题旁显示「显示/隐藏派生同级」开关（仅教师后台）
  onShowDerivedChange?: (v: boolean) => void;
  externalFocus?: { cid: string; ts: number } | null; // 外部请求聚焦（如路径查询点击某概念）
}

const EDGE_STYLE = {
  higher: { color: '#4361EE', arrows: 'to' as const, dashes: false },
  peer: { color: '#3AA65F', dashes: true },
  contrast: { color: '#FF7A59', dashes: true },
};

export default function ConceptMapViewer({
  vocab,
  title = '关系网络',
  height = 420,
  showDerived = false,
  showToggle = false,
  onShowDerivedChange,
  externalFocus,
}: Props) {
  const graphRef = useRef<HTMLDivElement>(null);
  const [focusQ, setFocusQ] = useState('');       // 聚焦检索词
  const [focusCid, setFocusCid] = useState<string | null>(null); // 聚焦的概念组（null = 全图）
  const [focusDepth, setFocusDepth] = useState(1); // 聚焦范围（几度邻居；1=直接上下游）

  const graph = useMemo<ConceptGraph>(() => buildConceptGraph(vocab), [vocab]);

  // 外部请求聚焦（教师后台路径查询点击路径中的概念 → 在图谱聚焦它）
  const lastExternalTs = useRef<number | null>(null);
  useEffect(() => {
    if (externalFocus && externalFocus.ts !== lastExternalTs.current) {
      lastExternalTs.current = externalFocus.ts;
      setFocusCid(externalFocus.cid);
      setFocusQ('');
    }
  }, [externalFocus]);

  // 聚焦候选：按概念组名匹配（term 全等 > 前缀 > 包含，避免精确命中被截掉）
  const focusMatches = useMemo(() => {
    const q = focusQ.trim().toLowerCase();
    if (!q) return [];
    const rank = (t: string): number => {
      if (t === q) return 0;
      if (t.startsWith(q)) return 1;
      return 2;
    };
    return [...graph.nodes.values()]
      .filter((n) => n.term.toLowerCase().includes(q))
      .sort((a, b) => rank(a.term.toLowerCase()) - rank(b.term.toLowerCase()))
      .slice(0, 10);
  }, [focusQ, graph]);

  // 图谱可视化：节点按连通性（度数）着色体现核心概念地位
  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const g = graph;
    // 概念 id -> 组内条目（tooltip 展示卷 + 单元）
    const itemsByConcept = new Map<string, VocabItem[]>();
    for (const it of vocab) {
      const cid = conceptIdOf(it);
      const arr = itemsByConcept.get(cid) ?? [];
      arr.push(it);
      itemsByConcept.set(cid, arr);
    }
    // 度数（含派生同级：真实连通性 / 潜在核心地位）
    const degree = (cid: string) => g.neighbors.get(cid)?.length ?? 0;
    // 度数 → 颜色（读设计 token，深色模式自动跟随；浅底用深字保证可读）
    const cssVar = (name: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
    const colorCore = cssVar('--c-primary', '#0064E0');
    const colorStrong = cssVar('--c-primary-soft', '#0091FF');
    const colorMid = cssVar('--c-charcoal', '#444950');
    const colorLeaf = cssVar('--c-hairline', '#CED0D4');
    const ink = cssVar('--c-ink', '#1C1E21');
    const nodeColor = (deg: number) => (deg >= 12 ? colorCore : deg >= 6 ? colorStrong : deg >= 3 ? colorMid : colorLeaf);
    const nodeFont = (deg: number) => (deg >= 3 ? '#FFFFFF' : ink);
    const nodeSize = (deg: number) => 14 + Math.min(deg, 20);
    // 聚焦模式：按 focusDepth 做 BFS，显示焦点概念周围 n 度邻居；否则全图
    const colorFocus = cssVar('--c-critical', '#E41E3F');
    let shownCids: Set<string> | null = null;
    if (focusCid) {
      shownCids = new Set([focusCid]);
      let frontier = [focusCid];
      for (let d = 0; d < focusDepth; d++) {
        const next: string[] = [];
        for (const c of frontier) {
          for (const nb of g.neighbors.get(c) ?? []) {
            if (!shownCids.has(nb)) {
              shownCids.add(nb);
              next.push(nb);
            }
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
    }
    const nodes = new DataSet<VisNode>(
      [...g.nodes.keys()]
        .filter((cid) => !shownCids || shownCids.has(cid))
        .map((cid) => {
          const node = g.nodes.get(cid)!;
          const items = itemsByConcept.get(cid) ?? [];
          const rep = items[0];
          const deg = degree(cid);
          const subs = items
            .map((i) => `${i.paper}${i.unit?.length ? `（${i.unit.join('、')}）` : ''}`)
            .join(' / ');
          return {
            id: cid,
            label: node.term,
            title: `${node.term}${rep?.chinese ? `（${rep.chinese}）` : ''}` +
              `\n连接 ${deg} 个概念${node.depth >= 0 ? ` · 层级 ${node.depth + 1}` : ''}` +
              (items.length > 1 ? `\n条目：${subs}` : ''),
            shape: 'box',
            borderWidth: cid === focusCid ? 4 : 1,
            color: { border: cid === focusCid ? colorFocus : nodeColor(deg), background: nodeColor(deg) },
            font: { color: nodeFont(deg), size: nodeSize(deg), bold: cid === focusCid || deg >= 6 ? 'bold' : 'normal' },
          };
        }),
    );
    const edges = new DataSet<VisEdge>();
    let eid = 0;
    const inFocus = (a: string, b: string) => !shownCids || (shownCids.has(a) && shownCids.has(b));
    // higher：父（高）→ 子（低），箭头指向低
    for (const node of g.nodes.values()) {
      for (const child of node.children) {
        if (!inFocus(node.cid, child)) continue;
        edges.add({ id: `h${eid++}`, from: node.cid, to: child, arrows: 'to', label: '高于', color: { color: EDGE_STYLE.higher.color } });
      }
    }
    // 显式 peer / contrast（对称，各画一条）
    for (const [a, b] of g.explicitPeers) {
      if (!inFocus(a, b)) continue;
      edges.add({ id: `p${eid++}`, from: a, to: b, dashes: true, label: '并列', color: { color: EDGE_STYLE.peer.color } });
    }
    for (const [a, b] of g.contrasts) {
      if (!inFocus(a, b)) continue;
      edges.add({ id: `c${eid++}`, from: a, to: b, dashes: true, label: '相反', color: { color: EDGE_STYLE.contrast.color } });
    }
    // 显式并列的传递同级（A~B、B~C → A~C；由显式 peer 自动推导，不落库）
    for (const [a, b] of g.transitivePeers) {
      if (!inFocus(a, b)) continue;
      edges.add({ id: `t${eid++}`, from: a, to: b, dashes: true, label: '同级', color: { color: EDGE_STYLE.peer.color, opacity: 0.5 } });
    }
    // 派生同级（默认关：全开会过密/卡顿，仅教师在开关打开时显示）
    if (showDerived) {
      for (const [a, b] of g.derivedPeers) {
        if (!inFocus(a, b)) continue;
        edges.add({ id: `d${eid++}`, from: a, to: b, dashes: true, label: '同级', color: { color: EDGE_STYLE.peer.color, opacity: 0.35 } });
      }
    }
    const options: Options = {
      physics: { enabled: true, stabilization: { iterations: 200 } },
      nodes: { shape: 'box', font: { size: 14 } },
      edges: { font: { size: 11 } },
      interaction: { hover: true, tooltipDelay: 80 },
    };
    const network = new Network(el, { nodes, edges }, options);
    // 关键：覆盖 vis-network 默认的 touch-action:none，把「垂直滑动」手势交还给浏览器（滚动页面），
    // 双指捏合（缩放）不在 pan-y 范围内，仍由 vis-network 处理 → 两者共存
    const canvas = el.querySelector('canvas');
    if (canvas) canvas.style.touchAction = 'pan-y';
    // 缩放比例上下限：超出后钳制回合法区间（避免无限放大 / 缩到看不见）
    const MIN_SCALE = 0.4;
    const MAX_SCALE = 3;
    let clamping = false;
    network.on('zoom', () => {
      if (clamping) return;
      const s = network.getScale();
      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
      if (Math.abs(clamped - s) > 0.001) {
        clamping = true;
        network.moveTo({ scale: clamped, position: network.getViewPosition() });
        clamping = false;
      }
    });
    return () => network.destroy();
  }, [graph, showDerived, focusCid, focusDepth, vocab]);

  return (
    <div className="card" style={{ padding: '0.8rem' }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className="spacer" />
        {showToggle && (
          <button
            onClick={() => onShowDerivedChange?.(!showDerived)}
            style={{
              fontSize: '0.78rem',
              lineHeight: 1.2,
              padding: '0.12rem 0.55rem',
              borderRadius: 8,
              background: showDerived ? 'var(--accent)' : 'var(--c-canvas)',
              borderColor: showDerived ? 'var(--accent)' : 'var(--c-hairline-soft)',
              color: showDerived ? '#fff' : 'var(--c-charcoal)',
            }}
          >
            {showDerived ? '隐藏派生同级' : '显示派生同级'}
          </button>
        )}
      </div>
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.4rem' }}>
        蓝色箭头 = 高于（高→低）；绿色虚线 = 并列；红色虚线 = 相反。可拖动节点。
        节点颜色越深 = 连通性越强（潜在核心概念），tooltip 可见连接数 / 层级。
      </p>
      <div style={{ marginTop: '0.4rem', marginBottom: '0.6rem' }}>
        {focusCid ? (
          <div className="row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>已聚焦：</span>
            <b style={{ fontSize: '0.9rem' }}>{graph.nodes.get(focusCid)?.term}</b>
            <span className="muted" style={{ fontSize: '0.8rem', marginLeft: '0.3rem' }}>范围</span>
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                onClick={() => setFocusDepth(d)}
                style={{
                  fontSize: '0.78rem',
                  lineHeight: 1.2,
                  padding: '0.1rem 0.5rem',
                  borderRadius: 8,
                  background: focusDepth === d ? 'var(--accent)' : 'var(--c-canvas)',
                  borderColor: focusDepth === d ? 'var(--accent)' : 'var(--c-hairline-soft)',
                  color: focusDepth === d ? '#fff' : 'var(--c-charcoal)',
                }}
              >
                {d} 度
              </button>
            ))}
            <button
              className="ghost"
              style={{ padding: '0.15rem 0.5rem', fontSize: '0.8rem' }}
              onClick={() => { setFocusCid(null); setFocusQ(''); }}
            >
              清除
            </button>
          </div>
        ) : (
          <>
            <input
              type="text"
              placeholder="输入概念，聚焦其局部上下游…"
              value={focusQ}
              onChange={(e) => setFocusQ(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', fontSize: '0.88rem' }}
            />
            {focusMatches.length > 0 && (
              <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
                {focusMatches.map((n) => (
                  <button key={n.cid} onClick={() => { setFocusCid(n.cid); setFocusQ(''); }}>
                    {n.term}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div
        ref={graphRef}
        style={{ width: '100%', height, border: '1px solid var(--c-hairline-soft)', borderRadius: 'var(--r-md)', touchAction: 'pan-y' }}
      />
    </div>
  );
}
