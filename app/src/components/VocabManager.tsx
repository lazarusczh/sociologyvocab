import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import type { VocabItem } from '../lib/types';
import { stableId } from '../lib/shuffle';
import { unitsForPaper } from '../lib/unitMapping';
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
  const { vocab, replaceVocab } = useStore();
  const [paperFilter, setPaperFilter] = useState('all');
  const [unitFilter, setUnitFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null); // 非 null 表示正在新增/编辑
  const [editingId, setEditingId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const units = useMemo(() => unitsForPaper(paperFilter), [paperFilter]);

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
        <div className="card" style={{ marginBottom: '0.8rem', borderColor: 'var(--accent)' }}>
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
              {unitsForPaper(draft.paper).map((u) => (
                <button key={u} className={draft.units.includes(u) ? 'active' : ''} onClick={() => toggleUnit(u)}>{u}</button>
              ))}
              {unitsForPaper(draft.paper).length === 0 && <span className="muted" style={{ fontSize: '0.8rem' }}>该考卷暂无单元</span>}
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

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <div style={{ padding: '0.6rem 0.8rem' }}>
          <input
            type="text"
            placeholder="搜索术语名 / 中文…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: '20rem' }}
          />
        </div>
        {filtered.length === 0 ? (
          <div className="empty-state"><p className="muted">当前筛选下无词条</p></div>
        ) : (
          <table className="check-table">
            <thead>
              <tr>
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
                  <td>{i.term}</td>
                  <td className="muted">{i.chinese || '—'}</td>
                  <td>{i.paper}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{(i.unit ?? []).join('、') || '—'}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{i.aliases ? i.aliases.filter((a) => a !== i.term).join('、') || '—' : '—'}</td>
                  <td>
                    <button onClick={() => startEdit(i)}>编辑</button>
                    <button className="danger" onClick={() => remove(i)}>删除</button>
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
