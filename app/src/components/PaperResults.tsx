import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  listGrouperRuns, updateGrouperRun, deleteGrouperRun, listMsSections,
  type GrouperRunRow, type GrouperRunScore, type MsSectionRow,
} from '../lib/cloud';
import { bandLinear, buildRows, type RowSpec, type ThresholdRows } from '../lib/score';
import type { AssembleSlot, BankItem } from '../lib/grouper';

const srcLabelFor = (it: BankItem) => `${it.source.session} QP${it.source.comp}${it.source.q ? ' Q' + it.source.q : ''}`;

const modeLabel = (r: Pick<GrouperRunRow, 'mode' | 'template_label'>) =>
  r.mode === 'template' ? (r.template_label ?? '真题模板') : (r.template_label ?? (r.mode === 'single' ? '单题布置' : '目标凑分'));

// 原始分 → 等第（A* 未填时落到 A* 区间内只给 A，避免误判）
function gradeOf(raw: number, t: ThresholdRows, aStar: number | null): string {
  if (aStar != null && raw >= aStar) return 'A*';
  if (raw >= t.A) return 'A';
  if (raw >= t.B) return 'B';
  if (raw >= t.C) return 'C';
  if (raw >= t.D) return 'D';
  if (raw >= t.E) return 'E';
  return 'U';
}

interface ClassRow { id: string; name: string }

export default function PaperResults() {
  // —— 列表 ——
  const [runs, setRuns] = useState<GrouperRunRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [viewing, setViewing] = useState<GrouperRunRow | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  // —— 详情 ——
  const [entries, setEntries] = useState<GrouperRunScore[] | null>(null); // null = 名单加载中
  const [aStarInput, setAStarInput] = useState('');
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classFilter, setClassFilter] = useState('all'); // 'all' | 'none'(未分班) | classId
  const [newName, setNewName] = useState('');
  const [newClass, setNewClass] = useState('');
  const [saving, setSaving] = useState(false);
  const [msCache, setMsCache] = useState<Record<string, MsSectionRow[]>>({});
  const [msNote, setMsNote] = useState('');
  const [msKey, setMsKey] = useState('');

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setError('');
    try {
      setRuns(await listGrouperRuns());
    } catch (e) {
      setError((e as Error).message || '加载试卷记录失败');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const openRun = async (run: GrouperRunRow) => {
    setViewing(run);
    setAStarInput(run.a_star == null ? '' : String(run.a_star));
    setError('');
    setMsg('');
    setMsNote('');
    setMsKey('');
    setEntries(null);
    setClassFilter('all');
    setNewClass('');
    // 拉班级 + 已注册学生名单（与打卡核验同口径），与已存成绩合并
    try {
      const [clsRes, devRes, stuRes] = await Promise.all([
        supabase.from('classes').select('id, name').order('name'),
        supabase.from('user_roles').select('user_id').eq('role', 'developer'),
        supabase
          .from('student_data')
          .select('user_id, email, data, class_id')
          .order('email', { ascending: true }),
      ]);
      const classList = ((clsRes.data ?? []) as ClassRow[]);
      setClasses(classList);
      const classMap = new Map(classList.map((c) => [c.id, c.name]));
      const devIds = new Set(((devRes.data ?? []) as { user_id: string }[]).map((d) => d.user_id));
      const roster: GrouperRunScore[] = ((stuRes.data ?? []) as {
        user_id: string; email: string | null; data: { name?: string } | null; class_id?: string | null;
      }[])
        .filter((r) => !devIds.has(r.user_id))
        .map((r) => ({
          key: `account:${r.user_id}`,
          name: r.data?.name?.trim() || r.email || '（未命名）',
          classId: r.class_id ?? '',
          registered: true,
          raw: null,
        }));
      const saved = new Map(run.scores.map((s) => [s.key, s]));
      const merged = roster.map((s) => ({ ...s, raw: saved.get(s.key)?.raw ?? null }));
      const keys = new Set(merged.map((m) => m.key));
      for (const s of run.scores) {
        if (!keys.has(s.key)) merged.push(s); // 手动添加或已销号的学生，保留录入
        else if (classMap.get(s.classId ?? '')) {
          // 刷新姓名/班级快照（以最新名单为准）
          const cur = merged.find((m) => m.key === s.key);
          if (cur) { cur.classId = s.classId; cur.name = s.name; }
        }
      }
      setEntries(merged);
    } catch (e) {
      setError((e as Error).message || '加载学生名单失败');
      setEntries([]);
    }
  };

  const closeRun = () => {
    setViewing(null);
    setEntries(null);
  };

  const slots: AssembleSlot[] = useMemo(() => ((viewing?.slots ?? []) as AssembleSlot[]), [viewing]);
  const aStarNum = aStarInput.trim() === '' ? null : Math.max(0, Math.round(Number(aStarInput) || 0));

  const rows: RowSpec[] = useMemo(() => {
    const t = viewing?.thresholds;
    if (!viewing || !t) return [];
    return buildRows({ A: t.A, B: t.B, C: t.C, D: t.D, E: t.E }, viewing.full_raw, aStarNum);
  }, [viewing, aStarNum]);

  const shown = useMemo(() => {
    if (!entries) return [];
    if (classFilter === 'all') return entries;
    if (classFilter === 'none') return entries.filter((e) => !(e.classId ?? ''));
    return entries.filter((e) => (e.classId ?? '') === classFilter);
  }, [entries, classFilter]);

  const convOf = (raw: number) => (rows.length ? bandLinear(raw, viewing!.full_raw, rows) : null);

  const saveEntries = async () => {
    if (!viewing || !entries) return;
    setSaving(true);
    setError('');
    setMsg('');
    try {
      await updateGrouperRun(viewing.id, {
        a_star: aStarNum,
        scores: entries,
      });
      const n = entries.filter((e) => e.raw != null).length;
      setViewing((v) => (v ? { ...v, a_star: aStarNum, scores: entries } : v));
      setMsg(`已保存：录入 ${n}/${entries.length} 人成绩`);
      void refresh();
    } catch (e) {
      setError((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (runId: string) => {
    setError('');
    try {
      await deleteGrouperRun(runId);
      setRuns((rs) => rs.filter((r) => r.id !== runId));
      setConfirmDel(null);
      if (viewing?.id === runId) closeRun();
    } catch (e) {
      setError((e as Error).message || '删除失败');
    }
  };

  const addManual = () => {
    if (!newName.trim()) return;
    const cls = classFilter === 'all' || classFilter === 'none' ? newClass : classFilter;
    setEntries((prev) => (prev
      ? [...prev, {
          key: `manual:${Date.now()}:${Math.floor(Math.random() * 1e6)}`,
          name: newName.trim(),
          classId: cls || '',
          registered: false,
          raw: null,
        }]
      : prev));
    setNewName('');
    if (classFilter !== 'all' && classFilter !== 'none') setNewClass('');
  };

  const updateRaw = (key: string, raw: string) => {
    const v = raw.trim() === '' ? null : Math.max(0, Number(raw) || 0);
    setEntries((prev) => (prev ? prev.map((e) => (e.key === key ? { ...e, raw: v } : e)) : prev));
  };

  const removeManual = (key: string) => {
    setEntries((prev) => (prev ? prev.filter((e) => e.key !== key) : prev));
  };

  const showMs = async (it: BankItem) => {
    const k = `${it.source.session.toLowerCase()}_${it.source.comp}`;
    let mrows = msCache[k];
    if (!mrows) {
      try {
        mrows = await listMsSections(it.source.session, it.source.comp);
        setMsCache((m) => ({ ...m, [k]: mrows ?? [] }));
      } catch {
        mrows = [];
      }
    }
    const m = (mrows ?? []).find((s) => s.q.replace(/[()]/g, '') === (it.source.q || '')) || (mrows ?? [])[0];
    if (m?.pdf_url) {
      const page = m.page && m.page > 1 ? `#page=${m.page}` : '';
      window.open(`${m.pdf_url}${page}`, '_blank', 'noopener');
      setMsNote('');
    } else {
      setMsNote(`${srcLabelFor(it)} 的 ms PDF 尚未托管`);
    }
    setMsKey(it.qid);
  };

  const renderItem = (it: BankItem) => (
    <div className="card" key={it.qid} style={{ padding: '0.6rem 0.8rem', margin: '0.4rem 0' }}>
      <div className="row" style={{ gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="badge">{srcLabelFor(it)}</span>
        <span className="badge warn">{it.marks} 分</span>
        <span className="badge review">{it.kind}</span>
      </div>
      {it.statement && <p className="ppt-stmt" style={{ margin: '0.3rem 0 0.1rem' }}>{it.statement}</p>}
      <p className={it.statement ? 'muted' : ''} style={{ margin: '0.2rem 0 0', fontSize: '0.9rem' }}>{it.stem}</p>
      <div className="row" style={{ gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
        {it.topics.slice(-2).map((t) => <span key={t} className="ppt-tag" style={{ color: 'var(--c-stone)' }}>{t}</span>)}
        <button className="ppt-link" type="button" onClick={() => void showMs(it)}>ms PDF</button>
        {msNote && msKey === it.qid && <span className="muted" style={{ fontSize: '0.8rem' }}>{msNote}</span>}
      </div>
    </div>
  );

  // —— 详情视图 ——
  if (viewing) {
    const recorded = (entries ?? []).filter((e) => e.raw != null).length;
    return (
      <div>
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <button className="ghost" onClick={closeRun}>← 返回</button>
            <h3 style={{ margin: 0 }}>{viewing.title}</h3>
            <span className="spacer" />
            <button className="ghost danger" onClick={() => { if (confirmDel === viewing.id) { void doDelete(viewing.id); } else { setConfirmDel(viewing.id); } }}>
              {confirmDel === viewing.id ? '确认删除？' : '删除'}
            </button>
          </div>
          <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
            {modeLabel(viewing)} · P{viewing.paper} · 满分 {viewing.full_raw}
            {viewing.topic ? ` · 考点「${viewing.topic}」` : ''} · 创建于 {new Date(viewing.created_at).toLocaleString()}
          </p>
          {error && <div className="card" style={{ marginTop: '0.6rem', padding: '0.5rem 0.7rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>{error}</div>}
          {msg && <div className="card" style={{ marginTop: '0.6rem', padding: '0.5rem 0.7rem', background: 'var(--ok-bg)', borderColor: 'var(--ok)' }}>{msg}</div>}
        </div>

        {/* 卷面回放（阅卷时对照题目查 ms） */}
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              卷面回放（{slots.length} 个槽 · {slots.reduce((s, x) => s + x.items.length, 0)} 题）
            </summary>
            <div style={{ marginTop: '0.6rem' }}>
              {slots.length === 0 && <div className="muted">无卷面快照</div>}
              {slots.map((s) => (
                <div key={s.spec.key} style={{ marginTop: '0.4rem' }}>
                  <div className="collapse-head" style={{ fontSize: '0.9rem' }}>
                    <span>{s.spec.label}</span>
                    <span className="ppt-count">{s.items.length} 题{s.spec.count > 1 ? `（候选 ${s.spec.count}）` : ''}</span>
                  </div>
                  {s.items.length === 0 && <div className="muted" style={{ fontSize: '0.85rem' }}>该槽没有可用题</div>}
                  {s.items.map(renderItem)}
                </div>
              ))}
            </div>
          </details>
        </div>

        {/* 分数线换算 */}
        <div className="card" style={{ marginBottom: '0.8rem', padding: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.4rem' }}>
            <strong>分数线换算 · 当次满分 {viewing.full_raw}</strong>
            <span className="muted" style={{ fontSize: '0.8rem' }}>（保存时已冻结各档下限；A* 可随时补填）</span>
          </div>
          <table className="grp-score-table">
            <thead><tr><th>等级</th><th>原始分下限</th><th>百分制参考</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.grade}>
                  <td>{r.grade}</td>
                  <td>
                    {r.grade === 'A*'
                      ? <input className="grp-input" placeholder="教师定" value={aStarInput} onChange={(e) => setAStarInput(e.target.value)} style={{ width: '4.2rem' }} />
                      : (r.cieRaw ?? '—')}
                  </td>
                  <td>{r.schoolPct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 学生成绩登记 */}
        <div className="card">
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem' }}>
            <h3 style={{ margin: 0 }}>学生成绩</h3>
            <span className="spacer" />
            {entries && <span className="muted" style={{ fontSize: '0.85rem' }}>已录 {recorded}/{entries.length}</span>}
            <button className="primary" onClick={() => void saveEntries()} disabled={saving || entries === null}>
              {saving ? '保存中…' : '保存成绩'}
            </button>
          </div>

          <div className="tag-filter" style={{ marginTop: '0.6rem' }}>
            <button className={classFilter === 'all' ? 'active' : ''} onClick={() => setClassFilter('all')}>全部</button>
            {classes.map((c) => (
              <button key={c.id} className={classFilter === c.id ? 'active' : ''} onClick={() => setClassFilter(c.id)}>{c.name}</button>
            ))}
            <button className={classFilter === 'none' ? 'active' : ''} onClick={() => setClassFilter('none')}>未分班</button>
          </div>

          {entries === null ? (
            <div className="muted" style={{ padding: '1rem 0' }}>加载学生名单中…</div>
          ) : shown.length === 0 ? (
            <div className="empty-state" style={{ padding: '1.2rem' }}><p className="muted">{classFilter === 'all' ? '暂无学生数据' : '该班级暂无可录入学生'}</p></div>
          ) : (
            <div className="card" style={{ padding: 0, marginTop: '0.6rem', overflowX: 'auto' }}>
              <table className="check-table">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>班级</th>
                    <th style={{ width: '7rem' }}>卷面分 / {viewing.full_raw}</th>
                    <th>百分制</th>
                    <th>等第</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e) => {
                    const conv = e.raw == null ? null : convOf(e.raw);
                    const grade = e.raw == null || !viewing.thresholds ? null : gradeOf(e.raw, viewing.thresholds, aStarNum);
                    return (
                      <tr key={e.key} style={{ opacity: e.raw == null ? 0.75 : 1 }}>
                        <td>
                          {e.name}
                          {!e.registered && <span className="badge todo" style={{ marginLeft: '0.35rem' }}>未注册</span>}
                        </td>
                        <td>{e.classId ? (classes.find((c) => c.id === e.classId)?.name ?? '') : '未分班'}</td>
                        <td>
                          <input
                            type="number" min={0} max={viewing.full_raw} style={{ width: '4.6rem' }}
                            value={e.raw ?? ''} placeholder="—"
                            onChange={(ev) => updateRaw(e.key, ev.target.value)}
                          />
                        </td>
                        <td><strong>{conv == null ? '—' : conv.toFixed(1)}</strong></td>
                        <td>{grade && <span className="badge">{grade}</span>}</td>
                        <td>
                          {!e.registered && (
                            <button className="ppt-link" onClick={() => removeManual(e.key)}>移除</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="row" style={{ gap: '0.4rem', marginTop: '0.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>手动添加未注册学生：</span>
            <input
              className="grp-input" placeholder="学生姓名"
              style={{ width: '9rem' }} value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addManual(); }}
            />
            <select
              className="grp-input" value={classFilter === 'all' || classFilter === 'none' ? newClass : classFilter}
              onChange={(e) => setNewClass(e.target.value)}
              style={{ maxWidth: '10rem' }}
            >
              <option value="">未分班</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="grp-go" onClick={addManual}>添加</button>
          </div>
          <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.8rem' }}>
            原始分实时换算百分制（{viewing.full_raw} 分满分档内插值）；未注册学生仅记录姓名，不与账号绑定。
          </p>
        </div>
      </div>
    );
  }

  // —— 列表视图 ——
  return (
    <div>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>试卷成绩</h3>
          <span className="spacer" />
          {loadingList && <span className="muted" style={{ fontSize: '0.85rem' }}>加载中…</span>}
          <button className="ghost" onClick={refresh} disabled={loadingList}>刷新</button>
        </div>
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          在「组卷器」生成并保存的试卷记录都在这里。点开回访卷面、对照 ms 阅卷，并给学生录入卷面分 → 自动换算百分制。
        </p>
        {error && <div className="card" style={{ marginTop: '0.6rem', padding: '0.5rem 0.7rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>{error}</div>}
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!loadingList && runs.length === 0 ? (
          <div className="empty-state" style={{ padding: '2rem 1rem' }}>
            <p className="muted">还没有保存过试卷。去「组卷器」组一份卷并点「保存本卷」。</p>
          </div>
        ) : (
          <table className="check-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>卷种</th>
                <th>满分</th>
                <th>已录</th>
                <th>创建时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const rec = r.scores.filter((s) => s.raw != null).length;
                const total = r.scores.length;
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.title}</td>
                    <td>{modeLabel(r)}<span className="muted" style={{ marginLeft: '0.3rem' }}>P{r.paper}</span></td>
                    <td>{r.full_raw}</td>
                    <td>{total > 0 ? `${rec}/${total}` : '—'}</td>
                    <td>{new Date(r.created_at).toLocaleString()}</td>
                    <td>
                      <div className="row" style={{ gap: '0.35rem', flexWrap: 'nowrap' }}>
                        <button className="ppt-link" onClick={() => void openRun(r)}>查看 / 登记</button>
                        <button
                          className="ppt-link"
                          style={{ color: confirmDel === r.id ? 'var(--c-critical)' : undefined }}
                          onClick={() => {
                            if (confirmDel === r.id) void doDelete(r.id);
                            else setConfirmDel(r.id);
                          }}
                        >
                          {confirmDel === r.id ? '确认删除' : '删除'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
