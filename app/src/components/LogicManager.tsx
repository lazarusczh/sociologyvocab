import { useMemo, useState, useRef, useEffect, Fragment, type RefObject } from 'react';
import { useStore } from '../lib/store';
import type { VocabItem, ItemRelations } from '../lib/types';
import { conceptIdOf, suggestRelated } from '../lib/relationSuggest';
import { buildConceptGraph } from '../lib/conceptGraph';
import { kShortestPaths } from '../lib/chain';
import ConceptMapViewer from './ConceptMapViewer';

type RelType = 'higher' | 'lower' | 'peer' | 'contrast';

const REL_LABELS: Record<RelType, string> = {
  higher: '高于',
  lower: '低于',
  peer: '并列',
  contrast: '相反',
};

// 图谱边样式已随图谱卡片移入 ConceptMapViewer 组件
const PATH_K = 5; // 路径查询：最多列出的最短路径条数

// ---- 概念组归并已移入 lib/relationSuggest.ts（conceptIdOf），此处直接复用 ----

function matchVocab(vocab: VocabItem[], q: string, excludeIds: string[] = []): VocabItem[] {
  const ql = q.trim().toLowerCase();
  if (!ql) return [];
  const excluded = new Set(excludeIds.filter(Boolean));
  // 相关度排序：term/中文「全等 > 前缀 > 包含」，否则新建词条（追加在数组末尾）会在 slice 前被截掉
  const rank = (i: VocabItem): number => {
    const t = i.term.toLowerCase();
    const c = (i.chinese ?? '').toLowerCase();
    if (t === ql) return 0;
    if (c === ql) return 1;
    if (t.startsWith(ql)) return 2;
    if (c.startsWith(ql)) return 3;
    if (t.includes(ql)) return 4;
    return 5; // 仅中文包含
  };
  return vocab
    .filter(
      (i) =>
        !excluded.has(i.id) &&
        (i.term.toLowerCase().includes(ql) || (i.chinese ?? '').toLowerCase().includes(ql)),
    )
    .sort((a, b) => rank(a) - rank(b))
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
  // 路径查询点击「在图谱聚焦」用：通知 ConceptMapViewer 聚焦某个概念（ts 用于触发相同 cid 的重复请求）
  const [graphFocusReq, setGraphFocusReq] = useState<{ cid: string; ts: number } | null>(null);
  const [pqFrom, setPqFrom] = useState('');       // 路径查询：起点检索词
  const [pqTo, setPqTo] = useState('');           // 路径查询：终点检索词
  const [fromCid, setFromCid] = useState<string | null>(null); // 已选起点概念
  const [toCid, setToCid] = useState<string | null>(null);     // 已选终点概念
  const [foundPaths, setFoundPaths] = useState<string[][] | null>(null); // 查询结果
  const [pathErr, setPathErr] = useState('');
  const [uncoveredSeed, setUncoveredSeed] = useState(0); // 未覆盖随机推荐的换一批种子
  const [activePicker, setActivePicker] = useState<'a' | 'b' | null>(null); // 当前焦点在哪个检索框（随机推荐据此带入 A/B）
  const [relSearch, setRelSearch] = useState(''); // 关系列表搜索词
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

  // 概念层级图（图谱可视化 + 聚焦筛选共用）
  const graph = useMemo(() => buildConceptGraph(vocab), [vocab]);

  // 未覆盖概念组（没有任何关系边）及其代表词条——供随机推荐补覆盖
  const uncovered = useMemo(() => {
    const covered = new Set<string>();
    const reps = new Map<string, VocabItem>();
    for (const it of vocab) {
      const cid = conceptIdOf(it);
      if (!reps.has(cid)) reps.set(cid, it);
      if (it.relations && Object.keys(it.relations).length) covered.add(cid);
    }
    return [...reps.entries()].filter(([cid]) => !covered.has(cid)).map(([, it]) => it);
  }, [vocab]);

  // 随机抽一批未覆盖概念（仅在点「换一批」时重抽，不随覆盖集合变化自动刷新）
  const uncoveredPick = useMemo(() => {
    const arr = [...uncovered];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uncoveredSeed]);

  // ---- 路径查询（教师备课：查两个概念之间怎么通）----
  const termOf = (cid: string) => graph.nodes.get(cid)?.term ?? cid;
  const matchConcepts = (q: string) => {
    const ql = q.trim().toLowerCase();
    if (!ql) return [];
    return [...graph.nodes.values()]
      .filter((n) => n.term.toLowerCase().includes(ql))
      .slice(0, 10);
  };
  const runPathQuery = () => {
    setPathErr('');
    if (!fromCid || !toCid) return;
    setFoundPaths(kShortestPaths(graph, fromCid, toCid, PATH_K));
  };
  const renderPathPicker = (
    q: string,
    setQ: (s: string) => void,
    selected: string | null,
    onPick: (cid: string | null) => void,
    placeholder: string,
  ) => {
    const matches = matchConcepts(q);
    return (
      <div style={{ position: 'relative', flex: '1 1 12rem', minWidth: 0 }}>
        {selected ? (
          <button
            className="ghost"
            style={{ width: '100%', textAlign: 'left', fontSize: '0.88rem' }}
            onClick={() => { onPick(null); setFoundPaths(null); setPathErr(''); }}
            title="点击取消选择"
          >
            {termOf(selected)} ×
          </button>
        ) : (
          <>
            <input
              type="text"
              placeholder={placeholder}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', fontSize: '0.88rem' }}
            />
            {matches.length > 0 && (
              <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
                {matches.map((n) => (
                  <button key={n.cid} onClick={() => { onPick(n.cid); setQ(''); setFoundPaths(null); setPathErr(''); }}>
                    {n.term}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

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
    slot: 'a' | 'b', // 焦点感知：随机推荐据此决定带入 A 还是 B
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
          onFocus={() => { setOpen(true); setActivePicker(slot); }}
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
          {renderPicker(left ? [left] : [], (v) => setLeft(v[0] ?? null), leftQ, setLeftQ, leftMatches, leftOpen, setLeftOpen, '检索词条A…', false, leftInputRef, 'a')}
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
          {renderPicker(rights, setRights, rightQ, setRightQ, rightMatches, rightOpen, setRightOpen, '检索词条B…（可多选）', true, rightInputRef, 'b')}
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
          <div style={{ marginTop: '0.5rem', borderTop: '1px dashed var(--c-hairline-soft)', paddingTop: '0.45rem' }}>
            <div className="row" style={{ alignItems: 'center', marginBottom: '0.3rem' }}>
              <span className="muted" style={{ fontSize: '0.82rem' }}>尚未覆盖的概念（随机）：</span>
              <span className="spacer" />
              <button className="ghost" style={{ padding: '0.1rem 0.5rem', fontSize: '0.78rem' }} onClick={() => setUncoveredSeed((s) => s + 1)}>
                换一批
              </button>
            </div>
            {uncoveredPick.length === 0 ? (
              <span className="muted" style={{ fontSize: '0.82rem' }}>所有概念都已覆盖，无需再补。</span>
            ) : (
              <div className="tag-filter">
                {uncoveredPick.map((it) => (
                  <button
                    key={it.id}
                    title={`${it.chinese ?? ''} · ${it.paper}（将带入${activePicker === 'b' ? '词条B' : '词条A'}，可先点 A/B 检索框切换）`}
                    onClick={() => {
                      if (activePicker === 'b') {
                        if (!left) { setMsg('请先在上方选择词条A，再添加词条B。'); return; }
                        setRights((r) => (r.some((x) => x.id === it.id) ? r : [...r, it]));
                        setRightQ('');
                        setMsg(`已把「${it.term}」加入词条B。`);
                      } else {
                        setLeft(it); setLeftQ(''); setSavedAnchor(null);
                        setMsg(`已载入「${it.term}」为词条A，可开始建立关系。`);
                      }
                    }}
                  >
                    {it.term}
                  </button>
                ))}
              </div>
            )}
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

      <ConceptMapViewer
        vocab={vocab}
        title="关系网络"
        showDerived={showDerived}
        showToggle
        onShowDerivedChange={setShowDerived}
        externalFocus={graphFocusReq}
      />
      <div className="card" style={{ marginTop: '0.8rem', padding: '0.8rem' }}>
        <h3 style={{ margin: 0 }}>路径查询</h3>
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.3rem' }}>
          输入起点与终点概念，列出它们之间的最短路径（最多 {PATH_K} 条）。点路径里的概念可在上方图谱聚焦它。
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {renderPathPicker(pqFrom, setPqFrom, fromCid, setFromCid, '起点概念…')}
          <span className="muted" style={{ alignSelf: 'center' }}>→</span>
          {renderPathPicker(pqTo, setPqTo, toCid, setToCid, '终点概念…')}
          <button className="primary" onClick={runPathQuery} disabled={!fromCid || !toCid} style={{ alignSelf: 'flex-start' }}>
            查询路径
          </button>
        </div>
        {pathErr && <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginTop: '0.4rem' }}>{pathErr}</p>}
        {foundPaths && foundPaths.length > 0 && (
          <div style={{ marginTop: '0.6rem' }}>
            {foundPaths.map((p, i) => (
              <div key={`p${i}`} className="row" style={{ gap: '0.2rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.35rem' }}>
                <span className="badge">{p.length - 1} 跳</span>
                {p.map((cid, j) => (
                  <span key={`${j}-${cid}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                    <button
                      className="ghost"
                      style={{ padding: '0.05rem 0.45rem', fontSize: '0.85rem' }}
                      onClick={() => setGraphFocusReq({ cid, ts: Date.now() })}
                      title="在图谱聚焦这个概念"
                    >
                      {termOf(cid)}
                    </button>
                    {j < p.length - 1 && <span className="muted" style={{ fontSize: '0.7rem' }}>→</span>}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
        {foundPaths && foundPaths.length === 0 && (
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
            这两个概念之间在当前关系网络里没有通路（可能还没给它们之间建过足够的逻辑关系）。
          </p>
        )}
      </div>
    </div>
  );
}
