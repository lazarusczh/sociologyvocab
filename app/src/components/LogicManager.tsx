import { useMemo, useState, useRef, useEffect, type RefObject } from 'react';
import { useStore } from '../lib/store';
import type { VocabItem, ItemRelations } from '../lib/types';
import { Network, DataSet, type Node as VisNode, type Edge as VisEdge, type Options } from 'vis-network/standalone';

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

// ---- 概念组 ----
// 判断哪些条目属于同一个「概念」：默认按 type+term 归并（跨 paper 同名 = 同一概念）；
// 特例：同 term 但语义不同的条目需拆开（如 Cultural deprivation 的 deviance / identity 版）。
const CONCEPT_SPLIT_TERMS = new Set(['Cultural deprivation']);
function conceptIdOf(item: VocabItem): string {
  if (CONCEPT_SPLIT_TERMS.has(item.term)) {
    return `${item.type}|${item.term}|${(item.unit ?? []).slice().sort().join(',')}`;
  }
  return `${item.type}|${item.term}`;
}

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

export default function LogicManager() {
  const { vocab, replaceVocab } = useStore();
  const [leftQ, setLeftQ] = useState('');
  const [rightQ, setRightQ] = useState('');
  const [left, setLeft] = useState<VocabItem | null>(null);
  const [rights, setRights] = useState<VocabItem[]>([]); // 词条B：支持多选，批量建立关系
  const [rel, setRel] = useState<RelType>('higher');
  const [msg, setMsg] = useState('');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [relationsOpen, setRelationsOpen] = useState(false); // 已建立关系默认折叠，避免越积越长
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
    for (const b of rights) next = applyRelation(next, left, b, rel);
    replaceVocab(next);
    const bs = rights.map((b) => b.term).join('、');
    setMsg(`已保存：${left.term} ${REL_LABELS[rel]} ${bs}`);
    setLeft(null); setRights([]); setLeftQ(''); setRightQ('');
  };

  const del = (aId: string, bId: string, type: RelType) => {
    replaceVocab(removeRelation(vocab, aId, bId, type));
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

  // 图谱可视化：概念级聚合（节点 = 概念组，边 = 概念级去重），力导向自动布局，类型着色
  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    // itemId -> 概念 id；概念 id -> 组内条目
    const conceptById = new Map<string, string>();
    const itemsByConcept = new Map<string, VocabItem[]>();
    for (const it of vocab) {
      const cid = conceptIdOf(it);
      conceptById.set(it.id, cid);
      const arr = itemsByConcept.get(cid) ?? [];
      arr.push(it);
      itemsByConcept.set(cid, arr);
    }
    // 有关系的概念集合
    const relConcepts = new Set<string>();
    for (const it of vocab) {
      if (!it.relations) continue;
      const cid = conceptById.get(it.id);
      if (cid) relConcepts.add(cid);
      for (const k of ['higher', 'lower', 'peer', 'contrast'] as const) {
        for (const id of it.relations[k] ?? []) {
          const c = conceptById.get(id);
          if (c) relConcepts.add(c);
        }
      }
    }
    const nodes = new DataSet<VisNode>(
      [...relConcepts].map((cid) => {
        const items = itemsByConcept.get(cid)!;
        const rep = items[0];
        // tooltip 展示该概念下的所有条目（卷 + 单元）
        const subs = items
          .map((i) => `${i.paper}${i.unit?.length ? `（${i.unit.join('、')}）` : ''}`)
          .join(' / ');
        return {
          id: cid,
          label: rep.term,
          title: `${rep.term}${rep.chinese ? `（${rep.chinese}）` : ''}${items.length > 1 ? `\n条目：${subs}` : ''}`,
        };
      }),
    );
    const edges = new DataSet<VisEdge>();
    let eid = 0;
    const seen = new Set<string>();
    for (const it of vocab) {
      const ca = conceptById.get(it.id)!;
      for (const bid of it.relations?.higher ?? []) {
        const cb = conceptById.get(bid);
        if (!cb || ca === cb) continue; // 孤儿引用 / 同概念跳过
        const key = `h|${ca}|${cb}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // 高概念 → 低概念（箭头从高指向低）
        edges.add({ id: `h${eid++}`, from: cb, to: ca, arrows: 'to', label: '高于', color: { color: EDGE_STYLE.higher.color } });
      }
      // peer / contrast 对称，按概念 id 序只画一条
      for (const bid of it.relations?.peer ?? []) {
        const cb = conceptById.get(bid);
        if (!cb || ca === cb) continue;
        const key = `p|${[ca, cb].sort().join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.add({ id: `p${eid++}`, from: ca, to: cb, dashes: true, label: '并列', color: { color: EDGE_STYLE.peer.color } });
      }
      for (const bid of it.relations?.contrast ?? []) {
        const cb = conceptById.get(bid);
        if (!cb || ca === cb) continue;
        const key = `c|${[ca, cb].sort().join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.add({ id: `c${eid++}`, from: ca, to: cb, dashes: true, label: '相反', color: { color: EDGE_STYLE.contrast.color } });
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
  }, [vocab]);

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
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: '0.2rem', alignItems: 'center',
          padding: '0.2rem 0.45rem', border: '1px solid var(--border)', borderRadius: 8,
          background: 'var(--surface)', cursor: 'text', minHeight: '36px', boxSizing: 'border-box',
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
            style={{ padding: '0.45rem 0.6rem', fontSize: '0.9rem', width: 'auto', flexShrink: 0 }}
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
                      <tr key={idx}>
                        <td style={{ padding: '0.3rem 0.4rem', borderBottom: '1px solid var(--c-hairline-soft)', fontSize: '0.9rem' }}>
                          <b>{r.a.term}</b>
                          <span style={{ color: 'var(--c-steel)', margin: '0 0.35rem' }}>{REL_LABELS[r.type]}</span>
                          <b>{r.b.term}</b>
                        </td>
                        <td style={{ padding: '0.3rem 0.4rem', borderBottom: '1px solid var(--c-hairline-soft)', textAlign: 'right', width: 60 }}>
                          <button className="ghost" style={{ padding: '0.15rem 0.5rem', fontSize: '0.8rem' }} onClick={() => del(r.a.id, r.b.id, r.type)}>
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ))}
      </div>

      <div className="card" style={{ marginTop: '0.8rem', padding: '0.8rem' }}>
        <h3 style={{ marginTop: 0 }}>关系网络</h3>
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '-0.3rem' }}>
          蓝色箭头 = 高于（高→低）；绿色虚线 = 并列；红色虚线 = 相反。可拖动节点。
        </p>
        <div
          ref={graphRef}
          style={{ width: '100%', height: 420, border: '1px solid var(--c-hairline-soft)', borderRadius: 'var(--r-md)', touchAction: 'pan-y' }}
        />
      </div>
    </div>
  );
}
