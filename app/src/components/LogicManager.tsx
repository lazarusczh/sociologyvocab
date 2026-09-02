import { useMemo, useState, useRef, useEffect, Fragment, type RefObject } from 'react';
import { useStore } from '../lib/store';
import type { VocabItem, ItemRelations } from '../lib/types';
import { Network, DataSet, type Node as VisNode, type Edge as VisEdge, type Options } from 'vis-network/standalone';
import { conceptIdOf, suggestRelated } from '../lib/relationSuggest';
import { buildConceptGraph } from '../lib/conceptGraph';

type RelType = 'higher' | 'lower' | 'peer' | 'contrast';

const REL_LABELS: Record<RelType, string> = {
  higher: '高于',
  lower: '低于',
  peer: '并列',
  contrast: '相反',
};

// 图谱边样式（lower 是 higher 的反向，不单独画）
const EDGE_STYLE: Record<Exclude<RelType, 'lower'>, { color: string; arrows?: 'to'; dashes: boolean }> = {
  higher: { color: '#4361EE', arrows: 'to', dashes: false },
  peer: { color: '#3AA65F', dashes: true },
  contrast: { color: '#FF7A59', dashes: true },
};

// ---- 概念组归并已移入 lib/relationSuggest.ts（conceptIdOf），此处直接复用 ----

function matchVocab(vocab: VocabItem[], q: string, excludeIds: string[] = []): VocabItem[] {
  const ql = q.trim().toLowerCase();
  if (!ql) return [];
  const excluded = new Set(excludeIds.filter(Boolean));
  return vocab
    .filter(
      (i) =>
        !excluded.has(i.id) &&
        (i.term.toLowerCase().includes(ql) || i.chinese.toLowerCase().includes(ql)),
    )
    .slice(0, 12);
}

const push = (list: string[] | undefined, id: string): string[] | undefined =>
  list?.includes(id) ? list : [...(list ?? []), id];
const pull = (list: string[] | undefined, id: string): string[] | undefined => {
  const next = (list ?? []).filter((x) => x !== id);
  return next.length ? next : undefined;
};

// 对称写入一对条目间的关系
function writeRelation(
  touch: (id: string, fn: (r: ItemRelations) => ItemRelations) => void,
  xId: string,
  yId: string,
  type: RelType,
): void {
  if (type === 'higher') {
    // x 高于 y：y.higher 加 x；x.lower 加 y
    touch(xId, (r) => ({ ...r, lower: push(r.lower, yId) }));
    touch(yId, (r) => ({ ...r, higher: push(r.higher, xId) }));
  } else if (type === 'lower') {
    // x 低于 y：x.higher 加 y；y.lower 加 x
    touch(xId, (r) => ({ ...r, higher: push(r.higher, yId) }));
    touch(yId, (r) => ({ ...r, lower: push(r.lower, xId) }));
  } else if (type === 'peer') {
    touch(xId, (r) => ({ ...r, peer: push(r.peer, yId) }));
    touch(yId, (r) => ({ ...r, peer: push(r.peer, xId) }));
  } else {
    touch(xId, (r) => ({ ...r, contrast: push(r.contrast, yId) }));
    touch(yId, (r) => ({ ...r, contrast: push(r.contrast, xId) }));
  }
}

// 在词库上应用一条关系：按「概念级镜像」写入——A 概念组 × B 概念组的所有条目组合都建立关系，
// 保证任何 paper 的条目都有完整关系，出题/展示不受条目分裂影响
function applyRelation(vocab: VocabItem[], a: VocabItem, b: VocabItem, type: RelType): VocabItem[] {
  const byId = new Map(vocab.map((i) => [i.id, i]));
  const touch = (id: string, fn: (r: ItemRelations) => ItemRelations) => {
    const it = byId.get(id);
    if (!it) return;
    byId.set(id, { ...it, relations: fn(it.relations ?? {}) });
  };
  const aGroup = vocab.filter((i) => conceptIdOf(i) === conceptIdOf(a));
  const bGroup = vocab.filter((i) => conceptIdOf(i) === conceptIdOf(b));
  for (const x of aGroup) {
    for (const y of bGroup) {
      if (x.id === y.id) continue;
      writeRelation(touch, x.id, y.id, type);
    }
  }
  return vocab.map((i) => byId.get(i.id) ?? i);
}

// 对称移除一对条目间的关系
function removePair(
  touch: (id: string, fn: (r: ItemRelations) => ItemRelations) => void,
  xId: string,
  yId: string,
  type: RelType,
): void {
  if (type === 'higher' || type === 'lower') {
    touch(xId, (r) => ({ ...r, lower: pull(r.lower, yId) }));
    touch(yId, (r) => ({ ...r, higher: pull(r.higher, xId) }));
  } else if (type === 'peer') {
    touch(xId, (r) => ({ ...r, peer: pull(r.peer, yId) }));
    touch(yId, (r) => ({ ...r, peer: pull(r.peer, xId) }));
  } else {
    touch(xId, (r) => ({ ...r, contrast: pull(r.contrast, yId) }));
    touch(yId, (r) => ({ ...r, contrast: pull(r.contrast, xId) }));
  }
}

// 删除一条关系：按概念组联动移除（A 概念组 × B 概念组所有组合），与镜像写入对称
function removeRelation(vocab: VocabItem[], aId: string, bId: string, type: RelType): VocabItem[] {
  const byId = new Map(vocab.map((i) => [i.id, i]));
  const a = byId.get(aId);
  const b = byId.get(bId);
  if (!a || !b) return vocab;
  const touch = (id: string, fn: (r: ItemRelations) => ItemRelations) => {
    const it = byId.get(id);
    if (!it) return;
    byId.set(id, { ...it, relations: fn(it.relations ?? {}) });
  };
  const aGroup = vocab.filter((i) => conceptIdOf(i) === conceptIdOf(a));
  const bGroup = vocab.filter((i) => conceptIdOf(i) === conceptIdOf(b));
  for (const x of aGroup) {
    for (const y of bGroup) {
      if (x.id === y.id) continue;
      removePair(touch, x.id, y.id, type);
    }
  }
  return vocab.map((i) => byId.get(i.id) ?? i);
  }

  // 查询 A、B 概念组之间现存的关系类型（raw 字段语义；无则 null）。
  // 供「修改关系」保存时检测旧关系并替换（先删旧再建新）。
  function relationTypeBetween(vocab: VocabItem[], a: VocabItem, b: VocabItem): RelType | null {
  const aCid = conceptIdOf(a);
  const bCid = conceptIdOf(b);
  const bIds = new Set(vocab.filter((i) => conceptIdOf(i) === bCid).map((i) => i.id));
  for (const it of vocab) {
  if (conceptIdOf(it) !== aCid) continue;
  for (const t of ['higher', 'lower', 'peer', 'contrast'] as const) {
    if ((it.relations?.[t] ?? []).some((id) => bIds.has(id))) return t;
  }
  }
  return null;
  }

export default function LogicManager() {
  const { vocab, replaceVocab } = useStore();
  const [leftQ, setLeftQ] = useState('');
  const [rightQ, setRightQ] = useState('');
  const [left, setLeft] = useState<VocabItem | null>(null);
  const [rights, setRights] = useState<VocabItem[]>([]); // 词条B：支持多选，批量建立关系
  const [savedAnchor, setSavedAnchor] = useState<VocabItem | null>(null); // 最近保存的词条A（保存后 left 已清空，推荐依据回退到它）
  const [rel, setRel] = useState<RelType>('higher');
  const [msg, setMsg] = useState('');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [relationsOpen, setRelationsOpen] = useState(false); // 已建立关系默认折叠，避免越积越长
  const [showDerived, setShowDerived] = useState(false); // 图谱是否显示派生同级（共享父推导，默认关）
  const [editingRel, setEditingRel] = useState<{ a: VocabItem; b: VocabItem; type: RelType } | null>(null); // 正在编辑的关系（展开行内操作条）
  const [covType, setCovType] = useState<'all' | 'term' | 'scholar'>('all'); // 覆盖率统计的筛选（全部/术语/学者）
  const [relSearch, setRelSearch] = useState(''); // 关系列表搜索词
  const graphRef = useRef<HTMLDivElement>(null);
  const leftInputRef = useRef<HTMLInputElement>(null);
  const rightInputRef = useRef<HTMLInputElement>(null);

  const leftMatches = useMemo(
    () => matchVocab(vocab, leftQ, left ? [left.id] : []),
    [vocab, leftQ, left?.id],
  );
  const rightMatches = useMemo(
    () => matchVocab(vocab, rightQ, [left?.id ?? '', ...rights.map((r) => r.id)]),
    [vocab, rightQ, left?.id, rights],
  );

  // 已建立的关系：按「概念组」聚合去重（镜像条目不重复显示）
  const relations = useMemo(() => {
    const byId = new Map(vocab.map((i) => [i.id, i]));
    const seen = new Set<string>();
    const rows: { a: VocabItem; b: VocabItem; type: RelType }[] = [];
    for (const it of vocab) {
      const ca = conceptIdOf(it);
      // lower 字段 = 该词条的低概念列表：it 高于这些词条，展示统一按「高于」语义
      for (const bid of it.relations?.lower ?? []) {
        const b = byId.get(bid);
        if (!b) continue;
        const cb = conceptIdOf(b);
        if (ca === cb) continue;
        const key = `h|${ca}|${cb}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ a: it, b, type: 'higher' });
      }
      for (const bid of it.relations?.peer ?? []) {
        const b = byId.get(bid);
        if (!b) continue;
        const cb = conceptIdOf(b);
        if (ca === cb) continue;
        const key = `p|${[ca, cb].sort().join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ a: it, b, type: 'peer' });
      }
      for (const bid of it.relations?.contrast ?? []) {
        const b = byId.get(bid);
        if (!b) continue;
        const cb = conceptIdOf(b);
        if (ca === cb) continue;
        const key = `c|${[ca, cb].sort().join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ a: it, b, type: 'contrast' });
      }
    }
    return rows;
  }, [vocab]);

  // 编辑助手：推荐「可能相关且尚未入网」的词条（基于当前 A，或最近保存的 A）
  const suggestions = useMemo(() => {
    const anchor = left ?? savedAnchor;
    if (!anchor) return [];
    const exclude = [anchor.id, ...rights.map((r) => r.id)];
    return suggestRelated(vocab, anchor, exclude);
  }, [vocab, left, savedAnchor, rights]);

  // 覆盖率统计：有关系边（higher/lower/peer/contrast 任一）的概念组 / 全部概念组，按类型分
  const coverage = useMemo(() => {
    const mk = () => ({ total: 0, covered: 0 });
    const stat = { all: mk(), term: mk(), scholar: mk() };
    const cidsByType = { term: new Set<string>(), scholar: new Set<string>() };
    const coveredCids = new Set<string>();
    for (const it of vocab) {
      cidsByType[it.type].add(conceptIdOf(it));
      if (it.relations && Object.keys(it.relations).length) coveredCids.add(conceptIdOf(it));
    }
    stat.term.total = cidsByType.term.size;
    stat.scholar.total = cidsByType.scholar.size;
    stat.all.total = stat.term.total + stat.scholar.total;
    for (const cid of coveredCids) {
      stat.all.covered++;
      if (cidsByType.term.has(cid)) stat.term.covered++;
      if (cidsByType.scholar.has(cid)) stat.scholar.covered++;
    }
    return stat;
  }, [vocab]);

  // 关系列表搜索过滤（按两端词条英文名 / 中文匹配）
  const filteredRelations = useMemo(() => {
    const q = relSearch.trim().toLowerCase();
    if (!q) return relations;
    return relations.filter(
      (r) =>
        r.a.term.toLowerCase().includes(q) ||
        r.b.term.toLowerCase().includes(q) ||
        r.a.chinese.toLowerCase().includes(q) ||
        r.b.chinese.toLowerCase().includes(q),
    );
  }, [relations, relSearch]);

  const save = () => {
    if (!left) { setMsg('请先选择词条A'); return; }
    if (rights.length === 0) { setMsg('请先选择词条B'); return; }
    if (rights.some((b) => conceptIdOf(b) === conceptIdOf(left))) { setMsg('A 与所选 B 属于同一概念，无需建立关系'); return; }
    let next = vocab;
    for (const b of rights) {
      // 该 A-B 已存在其他类型的关系 → 先移除再建立（替换），供「修改关系」用
      const existing = relationTypeBetween(next, left, b);
      if (existing && existing !== rel) next = removeRelation(next, left.id, b.id, existing);
      next = applyRelation(next, left, b, rel);
    }
    replaceVocab(next);
    const bs = rights.map((b) => b.term).join('、');
    setMsg(`已保存：${left.term} ${REL_LABELS[rel]} ${bs}`);
    setSavedAnchor(left);
    setLeft(null); setRights([]); setLeftQ(''); setRightQ('');
  };

  const del = (aId: string, bId: string, type: RelType) => {
    replaceVocab(removeRelation(vocab, aId, bId, type));
  };

  // 「修改关系」：把该关系载入上方编辑区；保存时对同一 A-B 会先删旧再建新（替换）
  const loadEdit = () => {
    if (!editingRel) return;
    setLeft(editingRel.a);
    setRights([editingRel.b]);
    setRel(editingRel.type);
    setLeftQ(''); setRightQ('');
    setMsg(`已载入「${editingRel.a.term} ${REL_LABELS[editingRel.type]} ${editingRel.b.term}」到编辑区，改好后点保存（同一条直接替换）。`);
    setEditingRel(null);
  };

  // 幂等规范化（重建式）：提取「概念级关系」（方向按字段语义，去重、矛盾取先出现），
  // 然后清空所有条目级 relations、按概念组重新生成全镜像。
  // 一次性修复：方向污染 / 镜像不完整 / 孤儿引用 / 重复边。幂等：结果与现有一致则不写。
  useEffect(() => {
    const byId = new Map(vocab.map((i) => [i.id, i]));
    const cidOf = (id: string): string => {
      const it = byId.get(id);
      return it ? conceptIdOf(it) : '';
    };
    // 提取概念级关系
    const dirMap = new Map<string, { ca: string; cb: string; type: 'higher' | 'lower' }>();
    const symSet = new Set<string>();
    const symPairs: { ca: string; cb: string; type: 'peer' | 'contrast' }[] = [];
    for (const it of vocab) {
      const ca = conceptIdOf(it);
      // higher 字段 = 该词条的高概念列表：it 低于 bid
      for (const bid of it.relations?.higher ?? []) {
        const cb = cidOf(bid);
        if (!cb || ca === cb) continue;
        const key = `dir|${[ca, cb].sort().join('|')}`;
        if (!dirMap.has(key)) dirMap.set(key, { ca, cb, type: 'lower' });
      }
      // lower 字段 = 该词条的低概念列表：it 高于 bid
      for (const bid of it.relations?.lower ?? []) {
        const cb = cidOf(bid);
        if (!cb || ca === cb) continue;
        const key = `dir|${[ca, cb].sort().join('|')}`;
        if (!dirMap.has(key)) dirMap.set(key, { ca, cb, type: 'higher' });
      }
      for (const bid of it.relations?.peer ?? []) {
        const cb = cidOf(bid);
        if (!cb || ca === cb) continue;
        const key = `sym|${[ca, cb].sort().join('|')}`;
        if (!symSet.has(key)) { symSet.add(key); symPairs.push({ ca, cb, type: 'peer' }); }
      }
      for (const bid of it.relations?.contrast ?? []) {
        const cb = cidOf(bid);
        if (!cb || ca === cb) continue;
        const key = `sym|${[ca, cb].sort().join('|')}`;
        if (!symSet.has(key)) { symSet.add(key); symPairs.push({ ca, cb, type: 'contrast' }); }
      }
    }
    const pairs: { ca: string; cb: string; type: RelType }[] = [
      ...dirMap.values(),
      ...symPairs,
    ];
    if (pairs.length === 0) return;
    // 清空并重建镜像
    const groups = new Map<string, VocabItem[]>();
    for (const it of vocab) {
      const cid = conceptIdOf(it);
      const arr = groups.get(cid) ?? [];
      arr.push(it);
      groups.set(cid, arr);
    }
    const rebuilt: VocabItem[] = vocab.map((it) => ({ ...it, relations: undefined }));
    const map = new Map(rebuilt.map((i) => [i.id, i]));
    const touch = (id: string, fn: (r: ItemRelations) => ItemRelations) => {
      const it = map.get(id);
      if (!it) return;
      map.set(id, { ...it, relations: fn(it.relations ?? {}) });
    };
    for (const p of pairs) {
      const aGroup = groups.get(p.ca) ?? [];
      const bGroup = groups.get(p.cb) ?? [];
      for (const x of aGroup) {
        for (const y of bGroup) {
          if (x.id === y.id) continue;
          writeRelation(touch, x.id, y.id, p.type);
        }
      }
    }
    const next = rebuilt.map((i) => map.get(i.id) ?? i);
    if (JSON.stringify(next) !== JSON.stringify(vocab)) {
      replaceVocab(next);
    }
  }, [vocab, replaceVocab]);

  // 图谱可视化：基于 conceptGraph（层级推导层）——节点 = 概念组，
  // 按连通性（度数）着色体现核心概念地位；派生同级（共享父推导）可开关显示
  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const g = buildConceptGraph(vocab);
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
    const nodes = new DataSet<VisNode>(
      [...g.nodes.keys()].map((cid) => {
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
          color: { border: nodeColor(deg), background: nodeColor(deg) },
          font: { color: nodeFont(deg), size: nodeSize(deg), bold: deg >= 6 ? 'bold' : 'normal' },
        };
      }),
    );
    const edges = new DataSet<VisEdge>();
    let eid = 0;
    // higher：父（高）→ 子（低），箭头指向低
    for (const node of g.nodes.values()) {
      for (const child of node.children) {
        edges.add({ id: `h${eid++}`, from: node.cid, to: child, arrows: 'to', label: '高于', color: { color: EDGE_STYLE.higher.color } });
      }
    }
    // 显式 peer / contrast（对称，各画一条）
    for (const [a, b] of g.explicitPeers) {
      edges.add({ id: `p${eid++}`, from: a, to: b, dashes: true, label: '并列', color: { color: EDGE_STYLE.peer.color } });
    }
    for (const [a, b] of g.contrasts) {
      edges.add({ id: `c${eid++}`, from: a, to: b, dashes: true, label: '相反', color: { color: EDGE_STYLE.contrast.color } });
    }
    // 派生同级（默认关：全开 489 条会过密）
    if (showDerived) {
      for (const [a, b] of g.derivedPeers) {
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
  }, [vocab, showDerived]);

  const renderPicker = (
    values: VocabItem[],
    setValues: (v: VocabItem[]) => void,
    q: string,
    setQ: (s: string) => void,
    matches: VocabItem[],
    open: boolean,
    setOpen: (b: boolean) => void,
    placeholder: string,
    multi: boolean,
    inputRef: RefObject<HTMLInputElement | null>,
  ) => (
    <div style={{ position: 'relative', flex: '1 1 12rem', minWidth: 0 }}>
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: '0.2rem', alignItems: 'center',
          padding: '0.15rem 0.45rem', border: '1px solid var(--border)', borderRadius: 8,
          background: 'var(--surface)', cursor: 'text', boxSizing: 'border-box',
          ...(multi
            ? { minHeight: 'var(--h-btn-lg)', maxHeight: 96, overflowY: 'auto' } // 多选：允许随选中词条撑开（最多两行），超出滚动
            : { height: 'var(--h-btn-lg)', overflow: 'hidden' }), // 单选：与保存按钮等高
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {values.map((v) => (
          <span
            key={v.id}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.15rem',
              background: 'var(--c-surface-soft)', border: '1px solid var(--c-hairline)',
              borderRadius: 'var(--r-ctrl)', padding: '0.05rem 0.4rem', fontSize: '0.8rem',
            }}
          >
            {v.term}
            <button
              type="button"
              onClick={() => setValues(values.filter((x) => x.id !== v.id))}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: '0.85rem', lineHeight: 1 }}
              aria-label={`移除 ${v.term}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          style={{ flex: 1, minWidth: '80px', border: 'none', outline: 'none', background: 'transparent', padding: '0.1rem 0', fontSize: '0.88rem', width: 'auto' }}
          value={q}
          placeholder={values.length === 0 ? placeholder : ''}
          onChange={(e) => { if (!multi) setValues([]); setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      </div>
      {open && matches.length > 0 && (
        <div
          className="card"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
            maxHeight: 280, overflow: 'auto', marginTop: '0.25rem', padding: '0.25rem',
          }}
        >
          {matches.map((m) => (
            <button
              key={m.id}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none',
                background: 'transparent', padding: '0.4rem 0.55rem', cursor: 'pointer',
                borderRadius: 'var(--r-ctrl)',
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                if (multi) {
                  if (!values.some((x) => x.id === m.id)) setValues([...values, m]);
                  setQ('');
                  setOpen(true); // 多选：选完保留下拉，可继续追加
                } else {
                  setValues([m]);
                  setQ(''); // 单选：选完清空检索词，避免残留输入
                  setOpen(false);
                }
              }}
            >
              <span style={{ fontWeight: 600 }}>{m.term}</span>
              {m.chinese && <span className="muted" style={{ marginLeft: '0.4rem', fontSize: '0.85rem' }}>{m.chinese}</span>}
              <span className="muted" style={{ marginLeft: '0.3rem', fontSize: '0.75rem' }}>{m.type === 'scholar' ? '学者' : '术语'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="card" style={{ padding: '0.8rem' }}>
        <h2 style={{ marginTop: 0, marginBottom: '0.3rem' }}>逻辑管理</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0, marginBottom: '0.8rem' }}>
          手动建立词条间的逻辑关系：高于 / 低于（上下位）、并列（同级）、相反（对立）。保存后随「发布词库」同步云端。
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {renderPicker(left ? [left] : [], (v) => setLeft(v[0] ?? null), leftQ, setLeftQ, leftMatches, leftOpen, setLeftOpen, '检索词条A…', false, leftInputRef)}
          <select
            value={rel}
            onChange={(e) => setRel(e.target.value as RelType)}
            style={{ height: 'var(--h-btn-lg)', boxSizing: 'border-box', padding: '0 0.6rem', fontSize: '0.9rem', width: 'auto', flexShrink: 0 }}
          >
            <option value="higher">高于</option>
            <option value="lower">低于</option>
            <option value="peer">并列</option>
            <option value="contrast">相反</option>
          </select>
          {renderPicker(rights, setRights, rightQ, setRightQ, rightMatches, rightOpen, setRightOpen, '检索词条B…（可多选）', true, rightInputRef)}
          <button className="primary" onClick={save}>保存</button>
        </div>
      </div>
      {msg && <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.4rem' }}>{msg}</p>}
      {suggestions.length > 0 && (
        <div style={{ marginTop: '0.4rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>推荐相关词条：</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.3rem' }}>
            {suggestions.map((s) => (
              <button
                key={s.item.id}
                className="ghost"
                style={{ fontSize: '0.85rem', padding: '0.2rem 0.6rem' }}
                title={s.reasons.join('、')}
                onClick={() => {
                  setRights((r) => (r.some((x) => x.id === s.item.id) ? r : [...r, s.item]));
                  setRightQ('');
                }}
              >
                {s.item.term}
                <span className="muted" style={{ marginLeft: '0.3rem', fontSize: '0.75rem' }}>{s.reasons.join('·')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: '0.8rem', padding: '0.8rem' }}>
        <button
          type="button"
          className="collapse-head"
          aria-expanded={relationsOpen}
          onClick={() => setRelationsOpen((v) => !v)}
        >
          <span>已建立关系（{relations.length}）</span>
          <span className="collapse-caret">{relationsOpen ? '▾' : '▸'}</span>
        </button>
        <div style={{ marginTop: '0.5rem' }}>
          <div className="tag-filter">
            {(['all', 'term', 'scholar'] as const).map((t) => (
              <button key={t} className={covType === t ? 'active' : ''} onClick={() => setCovType(t)}>
                {t === 'all' ? '全部' : t === 'term' ? '术语' : '学者'}
              </button>
            ))}
          </div>
          <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--c-track)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${coverage[covType].total ? (coverage[covType].covered / coverage[covType].total) * 100 : 0}%`,
                  height: '100%',
                  background: 'var(--c-primary)',
                  transition: 'width .3s ease',
                }}
              />
            </div>
            <span className="muted" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
              已覆盖 {coverage[covType].covered} / {coverage[covType].total} 概念组
            </span>
          </div>
        </div>
        {relationsOpen &&
          (relations.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>暂无关系，先在上方建立一条吧。</p>
          ) : (
            <>
              <input
                style={{ marginTop: '0.5rem', fontSize: '0.88rem' }}
                placeholder="搜索词条名筛选…"
                value={relSearch}
                onChange={(e) => setRelSearch(e.target.value)}
              />
              {filteredRelations.length === 0 ? (
                <p className="muted" style={{ margin: '0.5rem 0 0' }}>没有匹配「{relSearch}」的关系。</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.4rem' }}>
                  <tbody>
                    {filteredRelations.map((r, idx) => (
                      <Fragment key={idx}>
                      <tr>
                        <td style={{ padding: '0.3rem 0.4rem', borderBottom: '1px solid var(--c-hairline-soft)', fontSize: '0.9rem' }}>
                          <b>{r.a.term}</b>
                          <span style={{ color: 'var(--c-steel)', margin: '0 0.35rem' }}>{REL_LABELS[r.type]}</span>
                          <b>{r.b.term}</b>
                        </td>
                        <td style={{ padding: '0.3rem 0.4rem', borderBottom: '1px solid var(--c-hairline-soft)', textAlign: 'right', width: 70 }}>
                          <button
                            className="ghost"
                            style={{ padding: '0.15rem 0.5rem', fontSize: '0.8rem' }}
                            onClick={() => {
                              const isEditing = editingRel?.a.id === r.a.id && editingRel?.b.id === r.b.id;
                              setEditingRel(isEditing ? null : { a: r.a, b: r.b, type: r.type });
                            }}
                          >
                            {editingRel?.a.id === r.a.id && editingRel?.b.id === r.b.id ? '收起' : '编辑'}
                          </button>
                        </td>
                      </tr>
                      {editingRel?.a.id === r.a.id && editingRel?.b.id === r.b.id && (
                        <tr>
                          <td colSpan={2} style={{ padding: '0.3rem 0.4rem', borderBottom: '1px solid var(--c-hairline-soft)' }}>
                            <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                              <span className="muted" style={{ fontSize: '0.85rem' }}>修改后保存将直接替换该关系：</span>
                              <button className="ghost" style={{ padding: '0.15rem 0.5rem', fontSize: '0.8rem' }} onClick={loadEdit}>修改关系</button>
                              <button
                                className="danger"
                                style={{ padding: '0.15rem 0.5rem', fontSize: '0.8rem' }}
                                onClick={() => { del(editingRel.a.id, editingRel.b.id, editingRel.type); setEditingRel(null); }}
                              >
                                删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ))}
      </div>

      <div className="card" style={{ marginTop: '0.8rem', padding: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>关系网络</h3>
          <span className="spacer" />
          <button
            onClick={() => setShowDerived((v) => !v)}
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
        </div>
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.4rem' }}>
          蓝色箭头 = 高于（高→低）；绿色虚线 = 并列；红色虚线 = 相反。可拖动节点。
          节点颜色越深 = 连通性越强（潜在核心概念），tooltip 可见连接数 / 层级。
        </p>
        <div
          ref={graphRef}
          style={{ width: '100%', height: 420, border: '1px solid var(--c-hairline-soft)', borderRadius: 'var(--r-md)', touchAction: 'pan-y' }}
        />
      </div>
    </div>
  );
}
