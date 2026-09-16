import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  listGrouperRuns, updateGrouperRun, deleteGrouperRun, listMsSections,
  ensureRunShortCode, listMbTaskLinks, listMbRoster,
  matchMbTask, replaceMbTaskLink, deleteMbTaskLink,
  type GrouperRunRow, type GrouperRunScore, type MsSectionRow, type MbTaskLinkRow,
} from '../lib/cloud';
import { bandLinear, buildRows, type RowSpec, type ThresholdRows } from '../lib/score';
import { inferGrade, type Grade } from '../lib/mbSync';
import { copyText } from '../lib/clipboard';
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

interface ClassRow {
  id: string;
  name: string;
  papers?: string[] | null;
  mb_class_url?: string | null;   // ManageBac 成绩册链接（班级管理页绑定）
  mb_class_id?: string | null;    // 从链接解析出的 ManageBac 班级号
}

// 班级分组别名（A1 与 AS 同义：学校目前把 A1 班登记为 AS）
const GROUP_ALIASES: Record<'A1' | 'A2', string[]> = { A1: ['A1', 'AS'], A2: ['A2'] };

// 依「作业范围」与「卷名」推断目标班级 id（无匹配或该班无学生则返回 ''）
// 规则：卷名里写了 AS/A1/A2 优先采信；否则 P1/P2 → A1、P3/P4 → A2（A1 学 Paper1-2、A2 学 Paper3-4）
function inferClassId(run: GrouperRunRow, classList: ClassRow[], list: GrouperRunScore[]): string {
  if (classList.length === 0) return '';
  const t = (run.title || '').toUpperCase();
  let group: 'A1' | 'A2';
  if (/\bAS\b/.test(t) || /\bA\s*1\b/.test(t)) group = 'A1';
  else if (/\bA\s*2\b/.test(t)) group = 'A2';
  else group = run.paper <= 2 ? 'A1' : 'A2';
  const names = GROUP_ALIASES[group];
  const normName = (s: string) => s.replace(/\s+/g, '').toUpperCase();
  const cls = classList.find((c) => names.includes(normName(c.name)))
    ?? classList.find((c) => names.some((n) => normName(c.name).includes(n)));
  if (!cls) return '';
  return list.some((e) => (e.classId ?? '') === cls.id) ? cls.id : '';
}

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
  const [emailByKey, setEmailByKey] = useState<Record<string, string>>({}); // key → 邮箱（导出给 ManageBac 用）

  // —— ManageBac 同步（短码 / task 绑定 / 名单）——
  const [shortCode, setShortCode] = useState<string | null>(null);
  const [links, setLinks] = useState<MbTaskLinkRow[]>([]);
  const [rosterCount, setRosterCount] = useState<number | null>(null);
  const [mbBusy, setMbBusy] = useState(false);
  const [manualCopy, setManualCopy] = useState('');   // 剪贴板被拒时，展示可手动 Ctrl+C 的文本
  const [regenCode, setRegenCode] = useState(false);  // 点「修正」后，回到可重选年级位的状态
  const [gradePick, setGradePick] = useState<Grade>('A1');

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
    setShortCode(run.mb_short_code ?? null);
    setLinks([]);
    setRosterCount(null);
    setRegenCode(false);
    setGradePick(inferGrade(run.title, run.paper));
    // 拉班级 + 已注册学生名单（与打卡核验同口径），与已存成绩合并
    try {
      const [clsRes, devRes, stuRes] = await Promise.all([
        supabase.from('classes').select('id, name, papers, mb_class_url, mb_class_id').order('name'),
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
      // 额外记住 key → 邮箱（成绩快照里不含邮箱，导出给 ManageBac 时要用）
      const mailOf: Record<string, string> = {};
      for (const r of ((stuRes.data ?? []) as { user_id: string; email: string | null }[])) {
        if (r.email) mailOf[`account:${r.user_id}`] = r.email;
      }
      setEmailByKey(mailOf);
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
      setClassFilter(inferClassId(run, classList, merged)); // 按作业范围/卷名自动选中 A1/A2 班
      // ManageBac：已绑定的 task（名单人数由下方 effect 按当前班级加载，切换班级时会重查）
      try {
        setLinks(await listMbTaskLinks(run.id));
      } catch {
        setLinks([]);
      }
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

  // 本次推断出的目标班级（用于高亮提示「已自动选中」）
  const inferredClassId = useMemo(
    () => (viewing ? inferClassId(viewing, classes, entries ?? []) : ''),
    [viewing, classes, entries],
  );

  // 当前生效班级：优先用教师手动切换的班级，其次用推断出的班级
  const activeMbClassId = classFilter !== 'all' && classFilter !== 'none' ? classFilter : inferredClassId;
  const mbClass = classes.find((c) => c.id === activeMbClassId) ?? null;

  // 当前班已绑定的那条 task（一条作业在每个班只保留一条）
  const curLink = links.find((l) => l.class_id === mbClass?.id) ?? null;

  // 该班已导入的 ManageBac 名单人数（切班级时重查；未导入则为 0）
  useEffect(() => {
    if (!activeMbClassId) {
      setRosterCount(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const rows = await listMbRoster(activeMbClassId);
        if (alive) setRosterCount(rows.length);
      } catch {
        if (alive) setRosterCount(null);
      }
    })();
    return () => { alive = false; };
  }, [activeMbClassId]);

  // 生成 / 重算短码（旧记录没有短码时用；新记录在保存时已自动生成；regenCode = 修正模式）
  const applyShortCode = async () => {
    if (!viewing) return;
    const forced = regenCode;
    setMbBusy(true);
    setError('');
    setMsg('');
    try {
      const code = await ensureRunShortCode(viewing.id, viewing.title, viewing.paper, forced, gradePick);
      setShortCode(code);
      setRegenCode(false);
      setViewing((v) => (v ? { ...v, mb_short_code: code } : v));
      setRuns((rs) => rs.map((r) => (r.id === viewing.id ? { ...r, mb_short_code: code } : r)));
      setMsg(forced
        ? (code === shortCode ? `重算后仍是 [${code}]` : `已重算为 [${code}] —— 记得把 ManageBac 的 task 名同步改一下`)
        : `已生成短码 [${code}]`);
    } catch (e) {
      setError('生成短码失败：' + ((e as Error).message || String(e)));
    } finally {
      setMbBusy(false);
    }
  };

  const copyShortCode = async () => {
    if (!shortCode) return;
    setError('');
    try {
      const how = await copyText(`[${shortCode}]`);
      if (how === 'failed') {
        setManualCopy(`[${shortCode}]`);
        setMsg('剪贴板被此环境拒绝：请在下方文本框里选中后按 Ctrl+C');
      } else {
        setMsg(`已复制 [${shortCode}] —— 粘到 ManageBac 的 task 名里即可`);
      }
    } catch (e) {
      setError('复制失败：' + ((e as Error).message || String(e)));
    }
  };

  // 进入「修正」模式：重选年级位后按它重算（默认取现码的年级位）
  const fixShortCode = () => {
    if (!shortCode) return;
    const g = shortCode.split('-')[0];
    setGradePick(g === 'A2' ? 'A2' : 'A1');
    setRegenCode(true);
  };

  // —— ManageBac task 绑定 ——
  // Worker 侧只读抓取；**匹配不到或多条一律停下报告，绝不猜、不写**（设计见《分数同步到ManageBac方案.md》）
  const bindTask = async () => {
    if (!viewing) return;
    if (!mbClass?.mb_class_id) {
      setError('该班还没绑定 ManageBac 成绩册：去「班级管理」贴一次该班的成绩册链接');
      return;
    }
    if (!shortCode) {
      setError('先生成短码，并把它粘进 ManageBac 的 task 名');
      return;
    }
    if (curLink && !confirm(`「${mbClass.name}」现绑定的是「${curLink.mb_task_name ?? curLink.mb_task_id}」，改成新匹配到的 task？`)) return;
    setMbBusy(true);
    setError('');
    setMsg('');
    try {
      const r = await matchMbTask(mbClass.mb_class_id, shortCode);
      if (!r.match) {
        const n = typeof r.taskCount === 'number' ? `（该班当前学期共 ${r.taskCount} 个 task）` : '';
        setError(
          `没有唯一匹配到 task：${r.reason ?? '未命中'}${n}。请检查 ManageBac 里那个 task 名是否含 [${shortCode}]（含方括号），或它是否在另一个学期。`,
        );
        return;
      }
      await replaceMbTaskLink({
        runId: viewing.id,
        classId: mbClass.id,
        mbClassId: mbClass.mb_class_id,
        mbTaskId: r.match.id,
        mbTaskName: r.match.name,
      });
      setLinks(await listMbTaskLinks(viewing.id));
      setMsg(`已绑定：${r.match.name}`);
    } catch (e) {
      setError('绑定失败：' + ((e as Error).message || String(e)));
    } finally {
      setMbBusy(false);
    }
  };

  const unbindTask = async (id: string) => {
    if (!viewing) return;
    if (!confirm('解除这条 task 绑定？')) return;
    setError('');
    setMsg('');
    try {
      await deleteMbTaskLink(id);
      setLinks(await listMbTaskLinks(viewing.id));
      setMsg('已解除 task 绑定');
    } catch (e) {
      setError('解除失败：' + ((e as Error).message || String(e)));
    }
  };

  // 复制成绩（供 ManageBac 用户脚本导入）：每行「邮箱<Tab>原始分」
  // 范围与当前筛选一致（切到某班则只复制该班）；手动添加的学生无邮箱，自动跳过
  const copyGradesForManageBac = async () => {
    if (!viewing || !entries) return;
    setError('');
    setMsg('');
    const scored = shown.filter((e) => e.raw != null);
    const rows = scored.filter((e) => emailByKey[e.key]);
    const skipped = scored.length - rows.length;
    if (rows.length === 0) {
      setError('没有可复制的成绩（需已录入分数且能对上邮箱；手动添加的学生没有邮箱）');
      return;
    }
    const text = rows.map((e) => `${emailByKey[e.key]}\t${e.raw}`).join('\n');
    try {
      const how = await copyText(text);
      if (how === 'failed') {
        setManualCopy(text);
        setMsg(`剪贴板被此环境拒绝：请在下方文本框里选中后按 Ctrl+C（共 ${rows.length} 条）`);
      } else {
        setMsg(`已复制 ${rows.length} 条（邮箱 + 原始分，本卷满分 ${viewing.full_raw}）${skipped ? `；${skipped} 条无邮箱已跳过` : ''}`);
      }
    } catch (e) {
      setError('复制失败：' + ((e as Error).message || String(e)));
    }
  };

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

        {/* ManageBac 同步：短码 / 班级绑定 / 名单 / task 绑定（设计见《分数同步到ManageBac方案.md》） */}
        <div className="card" style={{ marginBottom: '0.8rem', padding: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem' }}>
            <strong>ManageBac 同步</strong>
            <span className="badge">线上自动同步</span>
            {shortCode && !regenCode ? (
              <>
                <code style={{ fontWeight: 700, fontSize: '1rem' }}>[{shortCode}]</code>
                <button className="ghost" onClick={() => void copyShortCode()}>复制短码</button>
                <button className="ppt-link" onClick={fixShortCode} disabled={mbBusy}>修正</button>
              </>
            ) : (
              <>
                <select value={gradePick} onChange={(e) => setGradePick(e.target.value as Grade)} style={{ width: '5rem' }}>
                  <option value="A1">A1</option>
                  <option value="A2">A2</option>
                </select>
                <button className="primary" onClick={() => void applyShortCode()} disabled={mbBusy}>
                  {mbBusy ? '生成中…' : (regenCode ? '按此年级重算' : '生成短码')}
                </button>
                {regenCode && (
                  <button className="ppt-link" onClick={() => setRegenCode(false)}>取消</button>
                )}
              </>
            )}
            <span className="spacer" />
            <span className="muted" style={{ fontSize: '0.8rem' }}>当前班级：{mbClass ? mbClass.name : '未确定'}</span>
          </div>

          <p className="muted" style={{ margin: '0.45rem 0 0', fontSize: '0.85rem' }}>
            {shortCode
              ? <>把 <code>[{shortCode}]</code> 粘进 ManageBac 的 task 名（如 <code>[{shortCode}] AS Homework #4</code>），再回来绑定。</>
              : '先点「生成短码」，把它粘进 ManageBac 的 task 名。'}
          </p>

          <ul className="muted" style={{ margin: '0.45rem 0 0', paddingLeft: '1.1rem', fontSize: '0.85rem' }}>
            <li>
              班级绑定：
              {!mbClass
                ? '未确定班级（该班需有已注册学生，或先在上方切到某班）'
                : mbClass.mb_class_id
                  ? `已绑定 ManageBac 班级 ${mbClass.mb_class_id}`
                  : '未绑定 → 去「班级管理」贴一次该班的成绩册链接'}
            </li>
            <li>
              名单：
              {rosterCount === null
                ? '—'
                : rosterCount > 0
                  ? `已导入 ${rosterCount} 人`
                  : '未导入 → 去「班级管理」导入 ManageBac 导出的名单 xlsx'}
            </li>
            <li>
              task 绑定：
              {curLink ? curLink.mb_task_name ?? curLink.mb_task_id : '未绑定'}
              {curLink && (
                <button className="ppt-link" style={{ marginLeft: '0.4rem' }} onClick={() => void unbindTask(curLink.id)}>
                  解绑
                </button>
              )}
              <button
                className="primary"
                style={{ marginLeft: '0.4rem', fontSize: '0.8rem', padding: '0.1rem 0.5rem' }}
                onClick={() => void bindTask()}
                disabled={mbBusy || !shortCode || !mbClass?.mb_class_id}
                title={
                  !mbClass?.mb_class_id
                    ? '该班还没绑定 ManageBac 成绩册（去「班级管理」贴链接）'
                    : !shortCode
                      ? '先生成短码'
                      : '按短码在该班 task 列表里精确匹配'
                }
              >
                {mbBusy ? '匹配中…' : curLink ? '重新匹配' : '绑定'}
              </button>
            </li>
          </ul>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0.65rem 0 0' }} />

          {/* 兜底通道：保持零凭证、零服务器；按钮与输出格式（邮箱<Tab>分数）为硬约束，不得改动 */}
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.6rem' }}>
            <strong style={{ fontSize: '0.9rem' }}>本地脚本同步</strong>
            <span className="muted" style={{ fontSize: '0.8rem' }}>（兜底 · 零凭证、零服务器）</span>
            <span className="spacer" />
            <button className="ghost" onClick={() => void copyGradesForManageBac()} disabled={entries === null}>
              本地脚本同步
            </button>
          </div>
          <p className="muted" style={{ margin: '0.4rem 0 0', fontSize: '0.8rem' }}>
            复制本页已录成绩（每行「邮箱 + 分数」），由油猴脚本在 ManageBac 页面粘贴。线上自动同步不可用时的退路。
            {classFilter !== 'all' && classFilter !== 'none' ? '（只复制当前所选班级）' : ''}
          </p>
        </div>

        {manualCopy && (
          <div className="card" style={{ marginBottom: '0.8rem', padding: '0.6rem 0.7rem' }}>
            <div className="row" style={{ alignItems: 'center', gap: '0.4rem' }}>
              <strong style={{ fontSize: '0.9rem' }}>手动复制（剪贴板被此环境拒绝）</strong>
              <span className="spacer" />
              <button className="ppt-link" onClick={() => setManualCopy('')}>关闭</button>
            </div>
            <textarea
              readOnly
              value={manualCopy}
              rows={5}
              style={{ width: '100%', marginTop: '0.4rem', fontFamily: 'inherit' }}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.currentTarget.select()}
            />
            <p className="muted" style={{ margin: '0.3rem 0 0', fontSize: '0.78rem' }}>
              点一下文本框会全选，再按 Ctrl+C 即可。
            </p>
          </div>
        )}

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
            {inferredClassId && classFilter === inferredClassId && (
              <span className="muted" style={{ fontSize: '0.8rem', alignSelf: 'center' }}>（已按作业范围自动选中，可切换）</span>
            )}
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
                <th>短码</th>
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
                    <td>{r.mb_short_code ? <code>[{r.mb_short_code}]</code> : <span className="muted">—</span>}</td>
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
