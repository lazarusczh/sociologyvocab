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
  notes: string;
}

function toDraft(item: VocabItem): Draft {
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
    theory: d.theory.trim() || undefined,
    notes: d.notes.trim() || undefined,
  };
}

export default function VocabManager() {
  const { vocab, replaceVocab, unitOrder, addUnit, removeUnit, moveUnit, renameUnit } = useStore();
  const [paperFilter, setPaperFilter] = useState('all');
  const [unitFilter, setUnitFilter] = useState('all');
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

  const units = useMemo(() => unitsForPaper(paperFilter, unitOrder), [paperFilter, unitOrder]);
  const unitMgmtSubs = useMemo(() => subsForPaper(unitMgmtPaper, unitOrder), [unitMgmtPaper, unitOrder]);
  const unitMgmtList = unitOrder[`${unitMgmtPaper}|${unitMgmtSub}`] ?? [];
  // 所有单元（用于批量迁移目标下拉）
  const allUnits = useMemo(() => {
    const set = new Set<string>();
    for (const list of Object.values(unitOrder)) list.forEach((u) => set.add(u));
    return [...set];
  }, [unitOrder]);

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
      if (q && !(i.term.toLowerCase().includes(q) || i.chinese.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [vocab, paperFilter, unitFilter, search]);

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
          {draft.type === 'scholar' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginTop: '0.6rem' }}>
              <label>
                <span className="muted" style={{ fontSize: '0.8rem' }}>理论流派</span>
                <input value={draft.theory} onChange={(e) => setDraft({ ...draft, theory: e.target.value })} />
              </label>
              <label>
                <span className="muted" style={{ fontSize: '0.8rem' }}>备注</span>
                <input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
              </label>
            </div>
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
            <button onClick={() => setBatchMode(true)}>批量迁移单元</button>
          )}
        </div>
        {batchMode && (
          <div style={{ padding: '0.6rem 0.8rem', borderTop: '1px solid var(--border)', background: 'var(--accent-bg)' }}>
            <div className="row" style={{ alignItems: 'center', gap: '0.6rem' }}>
              <span style={{ fontWeight: 600 }}>已选 {selectedIds.size} 条</span>
              <select value={targetUnit} onChange={(e) => setTargetUnit(e.target.value)} style={{ maxWidth: '16rem' }}>
                <option value="">迁移到单元…</option>
                {allUnits.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <button className="primary" disabled={selectedIds.size === 0 || !targetUnit} onClick={applyBatchMove}>应用到所选</button>
              <button onClick={() => { setBatchMode(false); setSelectedIds(new Set()); }}>取消</button>
            </div>
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.3rem' }}>
              迁移会把所选词条的单元整体替换为目标单元（多选模式下暂不支持编辑/删除单个词条）。
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
