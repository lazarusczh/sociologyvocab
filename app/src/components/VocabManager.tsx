import { useMemo, useState, useRef, useEffect } from 'react';
import { useStore } from '../lib/store';
import type { VocabItem } from '../lib/types';
import { stableId } from '../lib/shuffle';
import { unitsForPaper, subsForPaper } from '../lib/unitMapping';
import { PAPER_ORDER } from '../lib/storage';

// 表单草稿
interface Draft {
  type: 'term' | 'scholar';
  term: string;
  chinese: string;
  definition: string;
  paper: string;
  category: string;
  units: string[];
  aliases: string; // 逗号分隔的可接受答案
  theory: string;
  theories: string[]; // 理论流派（多选标签）
  notes: string;
}

function toDraft(item: VocabItem): Draft {
  // 多选流派初始值 = 已有的 theories 多选 + 旧 theory 单值（去重），保证编辑时旧值可见可选
  const theories = item.theories ? [...item.theories] : [];
  if (item.theory && !theories.includes(item.theory)) theories.push(item.theory);
  return {
    type: item.type,
    term: item.term,
    chinese: item.chinese,
    definition: item.definition,
    paper: item.paper,
    category: item.category,
    units: item.unit ?? [],
    aliases: (item.aliases ?? []).join(', '),
    theory: item.theory ?? '',
    theories,
    notes: item.notes ?? '',
  };
}

function fromDraft(d: Draft, oldId?: string): VocabItem {
  const aliases = d.aliases.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return {
    id: oldId ?? stableId(d.type, d.term, d.paper, d.category, d.units),
    type: d.type,
    term: d.term.trim(),
    chinese: d.chinese.trim(),
    definition: d.definition.trim(),
    paper: d.paper,
    category: d.category,
    unit: d.units.length ? d.units : undefined,
    aliases: aliases.length ? aliases : undefined,
    // 单值 theory 仅供学者（术语的流派信息一律走多选 theories，避免触发旧显示逻辑）
    theory: d.type === 'scholar' ? (d.theory.trim() || undefined) : undefined,
    theories: d.theories.length ? d.theories : undefined,
    notes: d.type === 'scholar' ? (d.notes.trim() || undefined) : undefined,
  };
}

export default function VocabManager() {
  const { vocab, replaceVocab, unitOrder, addUnit, removeUnit, moveUnit, renameUnit, vocabDirty } = useStore();
  const [paperFilter, setPaperFilter] = useState('all');
  const [unitFilter, setUnitFilter] = useState('all');
  const [theoryFilter, setTheoryFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null); // 非 null 表示正在新增/编辑
  const [editingId, setEditingId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  // 单元管理卡片
  const [unitMgmtOpen, setUnitMgmtOpen] = useState(false);
  const [unitMgmtPaper, setUnitMgmtPaper] = useState('Paper 1');
  const [unitMgmtSub, setUnitMgmtSub] = useState('');
  const [newUnitName, setNewUnitName] = useState('');
  const [renamingUnit, setRenamingUnit] = useState<string | null>(null); // 正在重命名的单元旧名
  const [renameValue, setRenameValue] = useState('');
  const [unitMsg, setUnitMsg] = useState('');
  // 批量迁移单元
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [targetUnit, setTargetUnit] = useState('');
  // 批量编辑流派
  const [targetTheory, setTargetTheory] = useState('');
  const [theoryBatchAction, setTheoryBatchAction] = useState<'add' | 'remove'>('add');
  // 流派管理
  const [theoryMgmtOpen, setTheoryMgmtOpen] = useState(false);
  const [theoryRenameFrom, setTheoryRenameFrom] = useState<string | null>(null);
  const [theoryRenameValue, setTheoryRenameValue] = useState('');
  const [theoryMsg, setTheoryMsg] = useState('');
  // 理论流派（多选标签）
  const [newTheory, setNewTheory] = useState('');

  const units = useMemo(() => unitsForPaper(paperFilter, unitOrder), [paperFilter, unitOrder]);
  const unitMgmtSubs = useMemo(() => subsForPaper(unitMgmtPaper, unitOrder), [unitMgmtPaper, unitOrder]);
  const unitMgmtList = unitOrder[`${unitMgmtPaper}|${unitMgmtSub}`] ?? [];
  // 所有单元（用于批量迁移目标下拉）
  const allUnits = useMemo(() => {
    const set = new Set<string>();
    for (const list of Object.values(unitOrder)) list.forEach((u) => set.add(u));
    return [...set];
  }, [unitOrder]);

  // 理论流派候选：从词库所有词条的 theory（单值）与 theories（多选）汇总去重
  const theoryCandidates = useMemo(() => {
    const set = new Set<string>();
    for (const i of vocab) {
      if (i.theory) set.add(i.theory);
      (i.theories ?? []).forEach((t) => t && set.add(t));
    }
    return [...set].sort();
  }, [vocab]);

  // 各流派的使用次数（单值 theory + 多选 theories 均计数；供流派管理展示/判断残留）
  const theoryUsage = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of vocab) {
      if (i.theory) m.set(i.theory, (m.get(i.theory) ?? 0) + 1);
      for (const t of i.theories ?? []) if (t) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [vocab]);

  // 打开编辑/新增表单时，自动滚动到表单位置（仅「关闭 → 打开」边沿触发）
  const formRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = !!draft;
    if (isOpen && !wasOpenRef.current) {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    wasOpenRef.current = isOpen;
  }, [draft]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vocab.filter((i) => {
      if (paperFilter !== 'all' && i.paper !== paperFilter) return false;
      if (unitFilter !== 'all' && !(i.unit ?? []).includes(unitFilter)) return false;
      if (theoryFilter !== 'all' && !(i.theory === theoryFilter || (i.theories ?? []).includes(theoryFilter))) return false;
      if (q && !(i.term.toLowerCase().includes(q) || i.chinese.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [vocab, paperFilter, unitFilter, theoryFilter, search]);

  const startCreate = () => {
    setDraft({
      type: 'term',
      term: '',
      chinese: '',
      definition: '',
      paper: 'Paper 1',
      category: '',
      units: [],
      aliases: '',
      theory: '',
      theories: [],
      notes: '',
    });
    setEditingId(null);
    setMsg('');
  };

  const startEdit = (item: VocabItem) => {
    setDraft(toDraft(item));
    setEditingId(item.id);
    setMsg('');
  };

  const toggleUnit = (u: string) => {
    setDraft((d) => {
      if (!d) return d;
      const has = d.units.includes(u);
      return { ...d, units: has ? d.units.filter((x) => x !== u) : [...d.units, u] };
    });
  };

  // 理论流派多选：点选切换；仅学者同步更新单值 theory 字段（取多选首项，保证旧显示逻辑一致）
  const toggleTheory = (t: string) => {
    setDraft((d) => {
      if (!d) return d;
      const has = d.theories.includes(t);
      const theories = has ? d.theories.filter((x) => x !== t) : [...d.theories, t];
      // 术语：只写多选 theories；学者：额外同步单值 theory（供 Spelling/crossword 等旧显示逻辑）
      return d.type === 'scholar' ? { ...d, theories, theory: theories[0] ?? '' } : { ...d, theories };
    });
  };

  // 新建理论流派：输入框回车/点添加，加入当前草稿的多选（若已存在则忽略）
  const addNewTheory = () => {
    const t = newTheory.trim();
    if (!t || !draft) return;
    setDraft((d) =>
      d && !d.theories.includes(t)
        ? d.type === 'scholar'
          ? { ...d, theories: [...d.theories, t], theory: d.theory || t }
          : { ...d, theories: [...d.theories, t] }
        : d
    );
    setNewTheory('');
  };

  const save = () => {
    if (!draft) return;
    if (!draft.term.trim() || !draft.definition.trim()) {
      setMsg('术语名和释义不能为空');
      return;
    }
    const item = fromDraft(draft, editingId ?? undefined);
    if (editingId) {
      replaceVocab(vocab.map((i) => (i.id === editingId ? item : i)));
      setMsg('已保存修改');
    } else {
      replaceVocab([...vocab, item]);
      setMsg('已新增词条');
    }
    setDraft(null);
    setEditingId(null);
  };

  const remove = (item: VocabItem) => {
    if (confirm(`确定删除「${item.term}」？`)) {
      replaceVocab(vocab.filter((i) => i.id !== item.id));
    }
  };

  // 批量迁移：勾选/全选
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allIds = filtered.map((i) => i.id);
    const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(allIds));
  };

  // 应用批量迁移：把选中词条的单元整体替换为目标单元
  const applyBatchMove = () => {
    if (!targetUnit || selectedIds.size === 0) return;
    replaceVocab(vocab.map((i) => (selectedIds.has(i.id) ? { ...i, unit: [targetUnit] } : i)));
    setSelectedIds(new Set());
    setBatchMode(false);
    setTargetUnit('');
  };

  // 应用批量编辑流派：对选中词条批量「追加」或「移除」某流派（只改多选 theories，不触碰单值 theory）
  const applyBatchTheory = () => {
    if (!targetTheory || selectedIds.size === 0) return;
    replaceVocab(vocab.map((i) => {
      if (!selectedIds.has(i.id)) return i;
      const cur = i.theories ?? [];
      const next = theoryBatchAction === 'add'
        ? (cur.includes(targetTheory) ? cur : [...cur, targetTheory])
        : cur.filter((t) => t !== targetTheory);
      return { ...i, theories: next.length ? next : undefined };
    }));
    setSelectedIds(new Set());
    setBatchMode(false);
    setTargetTheory('');
  };

  // 流派管理：开始重命名
  const startTheoryRename = (t: string) => {
    setTheoryRenameFrom(t);
    setTheoryRenameValue(t);
  };

  // 流派管理：确认重命名（把词库中所有该流派引用替换为新名，含单值 theory 与多选 theories）
  const confirmTheoryRename = () => {
    const newName = theoryRenameValue.trim();
    if (!theoryRenameFrom || !newName || newName === theoryRenameFrom) { setTheoryRenameFrom(null); return; }
    if (theoryUsage.has(newName)) { setTheoryMsg(`已存在同名流派「${newName}」`); return; }
    const from = theoryRenameFrom;
    replaceVocab(vocab.map((i) => {
      const th = i.theory === from ? newName : i.theory;
      const ths = i.theories?.map((t) => (t === from ? newName : t));
      return { ...i, theory: th, theories: ths && ths.length ? ths : undefined };
    }));
    setTheoryRenameFrom(null);
    setTheoryMsg(`已重命名「${from}」→「${newName}」`);
  };

  // 流派管理：删除流派（从所有词条移除该流派引用，含单值 theory 与多选 theories）
  const removeTheory = (t: string) => {
    if (!confirm(`确定删除流派「${t}」？\n\n将从所有词条中移除该流派（${theoryUsage.get(t) ?? 0} 处引用）。`)) return;
    replaceVocab(vocab.map((i) => {
      const th = i.theory === t ? undefined : i.theory;
      const ths = i.theories?.filter((x) => x !== t);
      return { ...i, theory: th, theories: ths && ths.length ? ths : undefined };
    }));
    setTheoryMsg(`已删除流派「${t}」`);
  };

  // 单元重命名
  const startRename = (u: string) => {
    setRenamingUnit(u);
    setRenameValue(u);
  };

  const confirmRename = () => {
    const newName = renameValue.trim();
    if (!renamingUnit) return;
    if (!newName || newName === renamingUnit) { setRenamingUnit(null); return; }
    if (unitMgmtList.includes(newName)) { setUnitMsg(`已存在同名单元「${newName}」`); return; }
    renameUnit(unitMgmtPaper, unitMgmtSub, renamingUnit, newName);
    setRenamingUnit(null);
    setUnitMsg(`已重命名「${renamingUnit}」→「${newName}」`);
  };

  return (
    <div>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>词条管理</h3>
          <span className="spacer" />
          <button className="primary" onClick={startCreate}>+ 单加一个词</button>
        </div>
        {vocabDirty && (
          <p style={{ fontSize: '0.85rem', marginTop: '0.3rem', color: 'var(--warn, #d97706)' }}>
            ⚠ 有未发布到云端的本地修改（含理论流派归类等）。到「批量导入」页点「发布新版本」才会同步给学生。
          </p>
        )}
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          浏览、新增、编辑、删除词条；修改后到「批量导入」页点「发布」同步给学生。
        </p>
        <div className="tag-filter" style={{ marginTop: '0.6rem' }}>
          <button className={paperFilter === 'all' ? 'active' : ''} onClick={() => { setPaperFilter('all'); setUnitFilter('all'); }}>全部考卷</button>
          {PAPER_ORDER.map((p) => (
            <button key={p} className={paperFilter === p ? 'active' : ''} onClick={() => { setPaperFilter(p); setUnitFilter('all'); }}>
              {p}
            </button>
          ))}
        </div>
        {units.length > 0 && (
          <div className="tag-filter" style={{ marginTop: '0.4rem' }}>
            <button className={unitFilter === 'all' ? 'active' : ''} onClick={() => setUnitFilter('all')}>全部单元</button>
            {units.map((u) => (
              <button key={u} className={unitFilter === u ? 'active' : ''} onClick={() => setUnitFilter(u)}>{u}</button>
            ))}
          </div>
        )}
      </div>

      {draft && (
        <div ref={formRef} className="card" style={{ marginBottom: '0.8rem', borderColor: 'var(--accent)' }}>
          <h3>{editingId ? '编辑词条' : '新增词条'}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginTop: '0.6rem' }}>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>类型</span>
              <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as 'term' | 'scholar' })}>
                <option value="term">术语</option>
                <option value="scholar">学者</option>
              </select>
            </label>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>考卷</span>
              <select value={draft.paper} onChange={(e) => setDraft({ ...draft, paper: e.target.value, units: [] })}>
                {PAPER_ORDER.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>术语名（英文）</span>
              <input value={draft.term} onChange={(e) => setDraft({ ...draft, term: e.target.value })} />
            </label>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>中文（学者可空）</span>
              <input value={draft.chinese} onChange={(e) => setDraft({ ...draft, chinese: e.target.value })} />
            </label>
          </div>
          <label style={{ display: 'block', marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.8rem' }}>释义</span>
            <input value={draft.definition} onChange={(e) => setDraft({ ...draft, definition: e.target.value })} />
          </label>
          <div style={{ marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.8rem' }}>理论流派（可多选，从候选点选或输入新建）</span>
            <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
              {theoryCandidates.map((t) => (
                <button
                  key={t}
                  className={draft.theories.includes(t) ? 'active' : ''}
                  onClick={() => toggleTheory(t)}
                  title={t}
                  style={{ maxWidth: '16rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >{t}</button>
              ))}
              {theoryCandidates.length === 0 && <span className="muted" style={{ fontSize: '0.8rem' }}>暂无流派，可在下方输入新建</span>}
            </div>
            <div className="row" style={{ marginTop: '0.3rem', gap: '0.4rem', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="新建流派名（如 Neo-Marxism）"
                value={newTheory}
                onChange={(e) => setNewTheory(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNewTheory(); } }}
                style={{ flex: 1, maxWidth: '18rem' }}
              />
              <button className="primary" disabled={!newTheory.trim()} onClick={addNewTheory}>+ 添加</button>
              {draft.theories.length > 0 && <span className="muted" style={{ fontSize: '0.8rem' }}>已选 {draft.theories.length} 个</span>}
            </div>
          </div>
          {draft.type === 'scholar' && (
            <label style={{ display: 'block', marginTop: '0.6rem' }}>
              <span className="muted" style={{ fontSize: '0.8rem' }}>备注</span>
              <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            </label>
          )}
          <div style={{ marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.8rem' }}>单元（可多选）</span>
            <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
              {unitsForPaper(draft.paper, unitOrder).map((u) => (
                <button key={u} className={draft.units.includes(u) ? 'active' : ''} onClick={() => toggleUnit(u)}>{u}</button>
              ))}
              {unitsForPaper(draft.paper, unitOrder).length === 0 && <span className="muted" style={{ fontSize: '0.8rem' }}>该考卷暂无单元</span>}
            </div>
          </div>
          <label style={{ display: 'block', marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.8rem' }}>额外可接受答案（除术语本身外，逗号分隔，可留空）</span>
            <input value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} placeholder="例如：tripartite" />
          </label>
          <div className="row" style={{ marginTop: '0.8rem' }}>
            <button className="primary" onClick={save}>保存</button>
            <button onClick={() => { setDraft(null); setEditingId(null); }}>取消</button>
            {msg && <span className="muted" style={{ fontSize: '0.85rem' }}>{msg}</span>}
          </div>
        </div>
      )}

      {/* 单元管理 */}
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <button
          className="collapse-head"
          onClick={() => setUnitMgmtOpen(!unitMgmtOpen)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%' }}
        >
          <span style={{ fontWeight: 600 }}>单元管理</span>
          <span className="muted" style={{ marginLeft: '0.4rem' }}>{unitMgmtOpen ? '▾ 收起' : '▸ 展开'}</span>
        </button>
        {unitMgmtOpen && (
          <div style={{ marginTop: '0.6rem' }}>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              增删、排序、重命名单元分类；修改后到「批量导入」页点「发布」同步给学生。
            </p>
            {unitMsg && (
              <div className="card" style={{ marginTop: '0.5rem', padding: '0.5rem 0.7rem', background: 'var(--accent-bg)', borderColor: 'var(--accent)' }}>
                {unitMsg}
              </div>
            )}
            <div className="tag-filter" style={{ marginTop: '0.6rem' }}>
              {PAPER_ORDER.map((p) => (
                <button
                  key={p}
                  className={unitMgmtPaper === p ? 'active' : ''}
                  onClick={() => { setUnitMgmtPaper(p); setUnitMgmtSub(subsForPaper(p, unitOrder)[0] ?? ''); }}
                >
                  {p}
                </button>
              ))}
            </div>
            {unitMgmtSubs.length > 1 && (
              <div className="tag-filter" style={{ marginTop: '0.4rem' }}>
                {unitMgmtSubs.map((s) => (
                  <button key={s} className={unitMgmtSub === s ? 'active' : ''} onClick={() => setUnitMgmtSub(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {unitMgmtList.map((u, idx) => (
                renamingUnit === u ? (
                  <div key={u} className="row" style={{ alignItems: 'center', gap: '0.4rem' }}>
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      style={{ flex: 1, maxWidth: '16rem' }}
                      autoFocus
                    />
                    <button className="primary" onClick={confirmRename}>保存</button>
                    <button onClick={() => setRenamingUnit(null)}>取消</button>
                  </div>
                ) : (
                  <div key={u} className="row" style={{ alignItems: 'center', gap: '0.4rem' }}>
                    <span className="badge">{u}</span>
                    <span className="spacer" />
                    <button onClick={() => moveUnit(unitMgmtPaper, unitMgmtSub, u, -1)} disabled={idx === 0}>↑</button>
                    <button onClick={() => moveUnit(unitMgmtPaper, unitMgmtSub, u, 1)} disabled={idx === unitMgmtList.length - 1}>↓</button>
                    <button onClick={() => startRename(u)}>重命名</button>
                    <button className="danger" onClick={() => removeUnit(unitMgmtPaper, unitMgmtSub, u)}>删除</button>
                  </div>
                )
              ))}
              {unitMgmtList.length === 0 && <p className="muted" style={{ fontSize: '0.85rem' }}>该考卷/主题暂无单元</p>}
            </div>
            <div className="row" style={{ marginTop: '0.6rem', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="新单元名"
                value={newUnitName}
                onChange={(e) => setNewUnitName(e.target.value)}
                style={{ flex: 1, maxWidth: '20rem' }}
              />
              <button
                className="primary"
                disabled={!newUnitName.trim()}
                onClick={() => { const n = newUnitName.trim(); if (n) { addUnit(unitMgmtPaper, unitMgmtSub, n); setNewUnitName(''); } }}
              >
                + 添加单元
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 流派管理 */}
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <button
          className="collapse-head"
          onClick={() => setTheoryMgmtOpen(!theoryMgmtOpen)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', width: '100%' }}
        >
          <span style={{ fontWeight: 600 }}>流派管理</span>
          <span className="muted" style={{ marginLeft: '0.4rem' }}>{theoryMgmtOpen ? '▾ 收起' : '▸ 展开'}</span>
        </button>
        {theoryMgmtOpen && (
          <div style={{ marginTop: '0.6rem' }}>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              按流派筛选词条：点选流派后下方表格只显示属于该流派的词条，可配合「批量编辑」迁移/合并。重命名、删除理论流派（学者单值 theory 与多选 theories 一并生效）；编辑词条后残留的旧流派会从下方自动消失。修改后到「批量导入」页点「发布」同步给学生。
            </p>
            {theoryCandidates.length > 0 && (
              <div className="tag-filter" style={{ marginTop: '0.4rem' }}>
                <button className={theoryFilter === 'all' ? 'active' : ''} onClick={() => setTheoryFilter('all')}>全部流派</button>
                {theoryCandidates.map((t) => (
                  <button
                    key={t}
                    className={theoryFilter === t ? 'active' : ''}
                    onClick={() => setTheoryFilter(t)}
                    title={t}
                    style={{ maxWidth: '14rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            {theoryMsg && (
              <div className="card" style={{ marginTop: '0.5rem', padding: '0.5rem 0.7rem', background: 'var(--accent-bg)', borderColor: 'var(--accent)' }}>
                {theoryMsg}
              </div>
            )}
            <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {theoryCandidates.map((t) => (
                theoryRenameFrom === t ? (
                  <div key={t} className="row" style={{ alignItems: 'center', gap: '0.4rem' }}>
                    <input
                      type="text"
                      value={theoryRenameValue}
                      onChange={(e) => setTheoryRenameValue(e.target.value)}
                      style={{ flex: 1, maxWidth: '18rem' }}
                      autoFocus
                    />
                    <button className="primary" onClick={confirmTheoryRename}>保存</button>
                    <button onClick={() => setTheoryRenameFrom(null)}>取消</button>
                  </div>
                ) : (
                  <div key={t} className="row" style={{ alignItems: 'center', gap: '0.4rem' }}>
                    <span className="badge" style={{ maxWidth: '26rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t}>{t}</span>
                    <span className="muted" style={{ fontSize: '0.8rem' }}>×{theoryUsage.get(t) ?? 0}</span>
                    <span className="spacer" />
                    <button onClick={() => startTheoryRename(t)}>重命名</button>
                    <button className="danger" onClick={() => removeTheory(t)}>删除</button>
                  </div>
                )
              ))}
              {theoryCandidates.length === 0 && <p className="muted" style={{ fontSize: '0.85rem' }}>暂无流派</p>}
            </div>
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
              提示：新流派在编辑单个词条时的「理论流派」输入框里创建并关联到词条后，才会出现在此列表。
            </p>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <div style={{ padding: '0.6rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="搜索术语名 / 中文…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: '20rem' }}
          />
          <span className="spacer" />
          {batchMode ? (
            <button onClick={() => { setBatchMode(false); setSelectedIds(new Set()); }}>退出多选</button>
          ) : (
            <button onClick={() => setBatchMode(true)}>批量编辑单元/流派</button>
          )}
        </div>
        {batchMode && (
          <div style={{ padding: '0.6rem 0.8rem', borderTop: '1px solid var(--border)', background: 'var(--accent-bg)' }}>
            <div className="row" style={{ alignItems: 'center', gap: '0.6rem' }}>
              <span style={{ fontWeight: 600 }}>已选 {selectedIds.size} 条</span>
            </div>
            <div className="row" style={{ alignItems: 'center', gap: '0.6rem', marginTop: '0.4rem' }}>
              <span className="muted" style={{ fontSize: '0.85rem', width: '3.5rem' }}>迁移单元</span>
              <select value={targetUnit} onChange={(e) => setTargetUnit(e.target.value)} style={{ maxWidth: '16rem' }}>
                <option value="">迁移到单元…</option>
                {allUnits.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <button className="primary" disabled={selectedIds.size === 0 || !targetUnit} onClick={applyBatchMove}>应用</button>
            </div>
            <div className="row" style={{ alignItems: 'center', gap: '0.6rem', marginTop: '0.4rem' }}>
              <span className="muted" style={{ fontSize: '0.85rem', width: '3.5rem' }}>编辑流派</span>
              <select
                value={theoryBatchAction}
                onChange={(e) => setTheoryBatchAction(e.target.value as 'add' | 'remove')}
                style={{ maxWidth: '7rem' }}
              >
                <option value="add">追加</option>
                <option value="remove">移除</option>
              </select>
              <select value={targetTheory} onChange={(e) => setTargetTheory(e.target.value)} style={{ maxWidth: '16rem' }}>
                <option value="">选择流派…</option>
                {theoryCandidates.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button className="primary" disabled={selectedIds.size === 0 || !targetTheory} onClick={applyBatchTheory}>应用</button>
            </div>
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.3rem' }}>
              迁移单元会把所选词条单元替换为目标单元；编辑流派可对所选词条批量「追加」或「移除」某流派（多选模式下暂不支持编辑/删除单个词条）。
            </p>
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="empty-state"><p className="muted">当前筛选下无词条</p></div>
        ) : (
          <table className="check-table">
            <thead>
              <tr>
                {batchMode && (
                  <th style={{ width: '2.2rem' }}>
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && filtered.every((i) => selectedIds.has(i.id))}
                      onChange={toggleSelectAll}
                      style={{ margin: 0 }}
                    />
                  </th>
                )}
                <th>术语/学者</th>
                <th>中文</th>
                <th>考卷</th>
                <th>单元</th>
                <th>理论流派</th>
                <th>可接受答案</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr key={i.id}>
                  {batchMode && (
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(i.id)}
                        onChange={() => toggleSelect(i.id)}
                        style={{ margin: 0 }}
                      />
                    </td>
                  )}
                  <td>{i.term}</td>
                  <td className="muted">{i.chinese || '—'}</td>
                  <td>{i.paper}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{(i.unit ?? []).join('、') || '—'}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>
                    <span
                      title={(i.theories && i.theories.length > 0 ? i.theories.join('、') : i.theory) || '待归类'}
                      style={{ display: 'inline-block', maxWidth: '14rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
                    >
                      {(i.theories && i.theories.length > 0 ? i.theories.join('、') : i.theory) || (
                        <span style={{ color: 'var(--warn, #d97706)' }}>待归类</span>
                      )}
                    </span>
                  </td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{i.aliases ? i.aliases.filter((a) => a !== i.term).join('、') || '—' : '—'}</td>
                  <td>
                    {batchMode ? (
                      <span className="muted" style={{ fontSize: '0.8rem' }}>—</span>
                    ) : (
                      <>
                        <button onClick={() => startEdit(i)}>编辑</button>
                        <button className="danger" onClick={() => remove(i)}>删除</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
