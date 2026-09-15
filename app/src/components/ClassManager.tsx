import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { maskEmail } from '../lib/shuffle';
import { countMbRosterByClass, listClassesWithMb, replaceMbRoster, setClassMbBinding, setStudentMbExempt } from '../lib/cloud';
import { parseMbClassUrl, parseRosterSheet } from '../lib/mbSync';

// 班级（含 ManageBac 绑定：成绩册 URL 与解析出的班级号）
interface ClassRow {
  id: string;
  name: string;
  papers: string[] | null;
  mb_class_url: string | null;
  mb_class_id: string | null;
}

// 云端 student_data 表的完整行（含 user_id / email / data / class_id）
interface StudentRow {
  user_id: string;
  email: string;
  name?: string;
  class_id?: string | null;
  mb_exempt?: boolean;   // true = 不登 ManageBac 分（不在 ManageBac 名单里的学生）
}

// 班级管理 + 学生分班：教师创建/重命名/删除班级，并为每个学生指定所属班级
export default function ClassManager() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // 新建班级名草稿
  const [newName, setNewName] = useState('');
  // 重命名草稿：{ id -> 名称 }
  const [editingName, setEditingName] = useState<{ id: string; name: string } | null>(null);

  // —— ManageBac 绑定与名单 ——
  const [mbDraft, setMbDraft] = useState<Record<string, string>>({});   // 班级 id → 输入框里的 URL
  const [mbBusy, setMbBusy] = useState('');
  const [rosterCount, setRosterCount] = useState<Record<string, number>>({});
  const [rosterNote, setRosterNote] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pendingClassRef = useRef<string>('');   // 点「导入名单」时记住是哪个班

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setMsg('');
    // 班级列表（含 ManageBac 绑定信息）
    try {
      setClasses(await listClassesWithMb());
    } catch (e) {
      setError((e as Error).message || '加载班级失败');
      setLoading(false);
      return;
    }
    // ManageBac 名单条数（一次拿全，避免逐班查询）
    try {
      setRosterCount(await countMbRosterByClass());
    } catch {
      setRosterCount({});
    }

    // 学生列表（排除 developer 测试账号，与打卡核验一致）
    const { data: devRows } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'developer');
    const devIds = new Set(((devRows ?? []) as { user_id: string }[]).map((d) => d.user_id));

    const { data: stuRows, error: stuErr } = await supabase
      .from('student_data')
      .select('user_id, email, data, class_id, mb_exempt')
      .order('email', { ascending: true });
    if (stuErr) {
      setError(stuErr.message);
      setLoading(false);
      return;
    }
    const list = ((stuRows ?? []) as (StudentRow & { data: { name?: string } })[])
      .filter((r) => !devIds.has(r.user_id))
      .map((r) => ({
        user_id: r.user_id,
        email: r.email,
        name: r.data?.name ?? '',
        class_id: r.class_id ?? null,
        mb_exempt: r.mb_exempt ?? false,
      }));
    setStudents(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 创建班级
  const createClass = async () => {
    const name = newName.trim();
    if (!name) return;
    const { error: err } = await supabase.from('classes').insert({ name });
    if (err) {
      setError(err.message);
      return;
    }
    setNewName('');
    setMsg(`已创建班级「${name}」`);
    load();
  };

  // 重命名班级
  const renameClass = async (id: string) => {
    if (!editingName || editingName.id !== id) return;
    const name = editingName.name.trim();
    if (!name) return;
    const { error: err } = await supabase.from('classes').update({ name }).eq('id', id);
    if (err) {
      setError(err.message);
      return;
    }
    setEditingName(null);
    setMsg('已重命名班级');
    load();
  };

  // 删除班级
  const deleteClass = async (c: ClassRow) => {
    if (!confirm(`确定删除班级「${c.name}」？该班学生的分班信息会被清空。`)) return;
    // 先清空该班学生的 class_id，再删班级
    const { error: clearErr } = await supabase
      .from('student_data')
      .update({ class_id: null })
      .eq('class_id', c.id);
    if (clearErr) {
      setError(clearErr.message);
      return;
    }
    const { error: err } = await supabase.from('classes').delete().eq('id', c.id);
    if (err) {
      setError(err.message);
      return;
    }
    setMsg(`已删除班级「${c.name}」`);
    load();
  };

  // 给学生指定/修改班级
  const assignClass = async (userId: string, classId: string | null) => {
    const { error: err } = await supabase
      .from('student_data')
      .update({ class_id: classId })
      .eq('user_id', userId);
    if (err) {
      setError(err.message);
      return;
    }
    // 本地同步，避免整页刷新
    setStudents((prev) => prev.map((s) => (s.user_id === userId ? { ...s, class_id: classId } : s)));
    setMsg('已更新分班');
  };

  // 「不登 ManageBac 分」开关（不在 ManageBac 名单里的学生，如自学学生）
  const toggleExempt = async (userId: string, exempt: boolean) => {
    setError('');
    setMsg('');
    try {
      await setStudentMbExempt(userId, exempt);
      setStudents((prev) => prev.map((s) => (s.user_id === userId ? { ...s, mb_exempt: exempt } : s)));
      setMsg(exempt ? '已标记为「不登 ManageBac 分」' : '已恢复「需登 ManageBac 分」');
    } catch (e) {
      setError((e as Error).message || '更新失败');
    }
  };

  // —— ManageBac：绑定 / 解除 / 导入名单 ——

  const bindMb = async (c: ClassRow) => {
    const parsed = parseMbClassUrl(mbDraft[c.id] ?? '');
    setError('');
    setMsg('');
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setMbBusy(c.id);
    try {
      await setClassMbBinding(c.id, (mbDraft[c.id] ?? '').trim(), parsed.classId);
      setMbDraft((d) => ({ ...d, [c.id]: '' }));
      setMsg(`「${c.name}」已绑定 ManageBac 班级 ${parsed.classId}`);
      load();
    } catch (e) {
      setError((e as Error).message || '绑定失败');
    } finally {
      setMbBusy('');
    }
  };

  const unbindMb = async (c: ClassRow) => {
    if (!confirm(`解除「${c.name}」的 ManageBac 绑定？（已导入的名单会保留）`)) return;
    setError('');
    setMsg('');
    try {
      await setClassMbBinding(c.id, null, null);
      setMsg(`已解除「${c.name}」的 ManageBac 绑定`);
      load();
    } catch (e) {
      setError((e as Error).message || '解除失败');
    }
  };

  const pickRoster = (classId: string) => {
    pendingClassRef.current = classId;
    fileRef.current?.click();
  };

  const onRosterFile = async (file: File) => {
    const classId = pendingClassRef.current;
    const cls = classes.find((c) => c.id === classId);
    if (!classId || !cls) return;
    setError('');
    setMsg('');
    setMbBusy(classId);
    try {
      const parsed = parseRosterSheet(await file.arrayBuffer());
      if (parsed.entries.length === 0) {
        setError(`没从「${file.name}」里认出「姓名 + 邮箱」行（识别到的邮箱列：${parsed.emailHeader || '未识别'}）。请确认导出的是班级名单。`);
        return;
      }
      const { data: auth } = await supabase.auth.getUser();
      const n = await replaceMbRoster(classId, parsed.entries, auth?.user?.id ?? null);
      // 与站内该班学生邮箱比对：有缺口就说明名单需要重新导出
      // 标了「不登分」的学生（如不进 ManageBac 名单的自学学生）不计入缺口，避免每次导入都报警
      const mine = new Set(
        students
          .filter((s) => (s.class_id ?? '') === classId && !s.mb_exempt)
          .map((s) => s.email.toLowerCase()),
      );
      const rosterEmails = new Set(parsed.entries.map((e) => e.email));
      const missing = [...mine].filter((e) => !rosterEmails.has(e)).length;
      const matched = mine.size - missing;
      setRosterNote((m) => ({
        ...m,
        [classId]: `已导入 ${n} 人${parsed.skipped ? `（跳过 ${parsed.skipped} 行缺姓名）` : ''}；`
          + `与本班站内学生邮箱匹配 ${matched}/${mine.size} 人`
          + (missing > 0 ? ` —— 有 ${missing} 名站内学生不在名单里，建议重新导出名单` : ''),
      }));
      setMsg(`「${cls.name}」名单已导入`);
      load();
    } catch (e) {
      setError('导入失败：' + ((e as Error).message || String(e)));
    } finally {
      setMbBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // 按班级分组显示（未分班在最前）
  const sortedClasses = [...classes].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const studentsByClass = (classId: string | null) =>
    students.filter((s) => (s.class_id ?? null) === classId);

  return (
    <div>
      {/* 班级管理 */}
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>班级管理</h3>
          <span className="spacer" />
          <button className="ghost" onClick={load} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          创建班级并给学生分班。分班后可在「打卡核验」里按班级筛选统计。
        </p>

        {error && (
          <div className="card" style={{ marginTop: '0.6rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
            操作失败：{error}
          </div>
        )}
        {msg && (
          <div className="card" style={{ marginTop: '0.6rem', background: 'var(--ok-bg)', borderColor: 'var(--ok)' }}>
            {msg}
          </div>
        )}

        {/* 新建班级 */}
        <div className="row" style={{ marginTop: '0.8rem', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="新班级名，如 A1 社会学"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: 1, maxWidth: '20rem' }}
          />
          <button className="primary" onClick={createClass} disabled={!newName.trim()}>
            + 创建班级
          </button>
        </div>

        {sortedClasses.length > 0 && (
          <div className="tag-filter" style={{ marginTop: '0.8rem' }}>
            {sortedClasses.map((c) =>
              editingName?.id === c.id ? (
                <span key={c.id} className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={editingName.name}
                    onChange={(e) => setEditingName({ id: c.id, name: e.target.value })}
                    style={{ maxWidth: '12rem' }}
                  />
                  <button className="primary" onClick={() => renameClass(c.id)}>保存</button>
                  <button onClick={() => setEditingName(null)}>取消</button>
                </span>
              ) : (
                <span key={c.id} className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                  <button className="active" style={{ cursor: 'default' }}>{c.name}</button>
                  <button onClick={() => setEditingName({ id: c.id, name: c.name })}>重命名</button>
                  <button className="danger" onClick={() => deleteClass(c)}>删除</button>
                </span>
              ),
            )}
          </div>
        )}
      </div>

      {/* ManageBac 绑定与名单（设计见《分数同步到ManageBac方案.md》） */}
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3 style={{ margin: 0 }}>ManageBac 绑定与名单</h3>
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          每个班绑定一次成绩册链接（浏览器地址栏里带 <code>/gradebook/</code> 的那条即可），并导入一次 ManageBac 导出的班级名单（含姓名与邮箱）。
          名单不必每学期重导；但若下面提示「有站内学生不在名单里」，就需要重新导出一次。
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onRosterFile(f); }}
        />
        {sortedClasses.length === 0 ? (
          <div className="empty-state" style={{ marginTop: '0.6rem' }}>
            <p className="muted">还没有班级。先在上面创建班级，再回来绑定 ManageBac。</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="check-table" style={{ marginTop: '0.6rem' }}>
              <thead>
                <tr>
                  <th>班级</th>
                  <th style={{ minWidth: '20rem' }}>ManageBac 成绩册链接</th>
                  <th>名单</th>
                </tr>
              </thead>
              <tbody>
                {sortedClasses.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td>
                      {c.mb_class_id ? (
                        <div className="row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                          <span className="badge">已绑定 · 班级 {c.mb_class_id}</span>
                          <button className="ppt-link" onClick={() => void unbindMb(c)}>解除</button>
                        </div>
                      ) : (
                        <div className="row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                          <input
                            type="text"
                            placeholder="粘贴 https://…/teacher/classes/…/gradebook/…"
                            value={mbDraft[c.id] ?? ''}
                            onChange={(e) => setMbDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                            style={{ flex: 1, minWidth: '16rem' }}
                          />
                          <button
                            className="primary"
                            onClick={() => void bindMb(c)}
                            disabled={mbBusy === c.id || !(mbDraft[c.id] ?? '').trim()}
                          >
                            {mbBusy === c.id ? '绑定中…' : '绑定'}
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className={rosterCount[c.id] ? 'badge' : 'badge todo'}>
                          {rosterCount[c.id] ? `${rosterCount[c.id]} 人` : '未导入'}
                        </span>
                        <button className="ppt-link" onClick={() => pickRoster(c.id)} disabled={mbBusy === c.id}>
                          {mbBusy === c.id ? '导入中…' : '导入名单 xlsx'}
                        </button>
                      </div>
                      {rosterNote[c.id] && (
                        <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.25rem' }}>{rosterNote[c.id]}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 学生分班 */}
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3 style={{ margin: 0 }}>学生分班</h3>
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          为每个学生选择所属班级（已排除 developer/测试账号）。未登录同步过的学生不会出现在这里。
        </p>

        {!loading && students.length === 0 && (
          <div className="empty-state" style={{ marginTop: '0.6rem' }}>
            <p className="muted">暂无学生数据。学生登录并同步后会自动出现在这里。</p>
          </div>
        )}

        {students.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="check-table" style={{ marginTop: '0.6rem' }}>
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>邮箱</th>
                  <th>班级</th>
                  <th>ManageBac 登分</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.user_id}>
                    <td>{s.name || '—'}</td>
                    <td className="muted">{maskEmail(s.email)}</td>
                    <td>
                      <select
                        value={s.class_id ?? ''}
                        onChange={(e) => assignClass(s.user_id, e.target.value || null)}
                        style={{ maxWidth: '100%' }}
                      >
                        <option value="">未分班</option>
                        {sortedClasses.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label className="row" style={{ gap: '0.3rem', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!!s.mb_exempt}
                          onChange={(e) => void toggleExempt(s.user_id, e.target.checked)}
                        />
                        <span className="muted" style={{ fontSize: '0.8rem' }}>
                          {s.mb_exempt ? '不登分' : '需登分'}
                        </span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 按班级分组预览 */}
        {!loading && students.length > 0 && sortedClasses.length > 0 && (
          <div style={{ marginTop: '0.8rem' }}>
            {[
              { id: null as string | null, name: '未分班', list: studentsByClass(null) },
              ...sortedClasses.map((c) => ({ id: c.id, name: c.name, list: studentsByClass(c.id) })),
            ]
              .filter((g) => g.list.length > 0)
              .map((g) => (
                <div key={g.id ?? 'none'} style={{ marginBottom: '0.5rem' }}>
                  <span className="muted" style={{ fontSize: '0.85rem' }}>
                    {g.name}（{g.list.length} 人）：
                  </span>
                  <span style={{ fontSize: '0.85rem' }}>
                    {g.list.map((s) => s.name || maskEmail(s.email)).join('、')}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
