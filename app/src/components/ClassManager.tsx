import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// 班级
interface ClassRow {
  id: string;
  name: string;
}

// 云端 student_data 表的完整行（含 user_id / email / data / class_id）
interface StudentRow {
  user_id: string;
  email: string;
  name?: string;
  class_id?: string | null;
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

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setMsg('');
    // 班级列表
    const { data: classRows, error: classErr } = await supabase
      .from('classes')
      .select('id, name')
      .order('name');
    if (classErr) {
      setError(classErr.message);
      setLoading(false);
      return;
    }
    setClasses((classRows ?? []) as ClassRow[]);

    // 学生列表（排除 developer 测试账号，与打卡核验一致）
    const { data: devRows } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'developer');
    const devIds = new Set(((devRows ?? []) as { user_id: string }[]).map((d) => d.user_id));

    const { data: stuRows, error: stuErr } = await supabase
      .from('student_data')
      .select('user_id, email, data, class_id')
      .order('email', { ascending: true });
    if (stuErr) {
      setError(stuErr.message);
      setLoading(false);
      return;
    }
    const list = ((stuRows ?? []) as (StudentRow & { data: { name?: string } })[])
      .filter((r) => !devIds.has(r.user_id))
      .map((r) => ({ user_id: r.user_id, email: r.email, name: r.data?.name ?? '', class_id: r.class_id ?? null }));
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
          <table className="check-table" style={{ marginTop: '0.6rem' }}>
            <thead>
              <tr>
                <th>姓名</th>
                <th>邮箱</th>
                <th>班级</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.user_id}>
                  <td>{s.name || '—'}</td>
                  <td className="muted">{s.email}</td>
                  <td>
                    <select
                      value={s.class_id ?? ''}
                      onChange={(e) => assignClass(s.user_id, e.target.value || null)}
                    >
                      <option value="">未分班</option>
                      {sortedClasses.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                    {g.list.map((s) => s.name || s.email).join('、')}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
