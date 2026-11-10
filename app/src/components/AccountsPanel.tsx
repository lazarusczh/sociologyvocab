import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// 账户 / 角色 / 班级归属（仅开发者可见，挂在 DevPanel 里）
//
// 为什么需要这块：项目目前没有「谁是老师」的管理界面，授予教师只能手写 SQL。
// 一旦有第二位教师（如承接 0495 的同事）加入，就必须能在页面上完成两件事：
//   1. 把某个已注册账号提升/降级为教师
//   2. 指定「哪个班归哪位教师」，写权限按这个归属收敛（见 db-migration-roles-and-ownership.sql）
//
// 所有写操作都走 SECURITY DEFINER 的 RPC，函数内部再验一次「调用者是 developer」。
// 前端读不到 auth.users，账户检索也必须经 RPC。
const ROLE_LABEL: Record<string, string> = {
  developer: '开发者',
  teacher: '教师',
  student: '学生',
  guest: '访客',
};

interface AccountRow {
  user_id: string;
  email: string;
  roles: string[] | null;
  last_sign_in_at: string | null;
  class_names: string[] | null;
}

interface ClassRow {
  id: string;
  name: string;
  syllabus: string | null;
  teacher_id: string | null;
  teacherEmail: string | null;
}

export default function AccountsPanel() {
  const [q, setQ] = useState('');
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const loadClasses = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('classes')
      .select('id, name, syllabus, teacher_id')
      .order('name');
    if (e) {
      setError(e.message);
      return;
    }
    const rows = (data ?? []) as { id: string; name: string; syllabus: string | null; teacher_id: string | null }[];

    // teacher_id → email：教师账号数量很少，但前端无权读 auth.users，改用账户检索 RPC 反查。
    // 检索入参为空时返回前 60 个账号，多数情况下足以覆盖全部教师。
    const nameById = new Map<string, string>();
    const { data: acc } = await supabase.rpc('admin_search_accounts', { q: '' });
    for (const a of (acc ?? []) as AccountRow[]) nameById.set(a.user_id, a.email);

    setClasses(
      rows.map((r) => ({
        ...r,
        teacherEmail: r.teacher_id ? nameById.get(r.teacher_id) ?? r.teacher_id : null,
      })),
    );
  }, []);

  const search = useCallback(async () => {
    setLoading(true);
    setError('');
    setMsg('');
    const { data, error: e } = await supabase.rpc('admin_search_accounts', { q });
    setLoading(false);
    if (e) {
      setError(e.message);
      return;
    }
    setAccounts((data ?? []) as AccountRow[]);
  }, [q]);

  useEffect(() => {
    void search();
    void loadClasses();
    // 首次进入按空关键词拉一页，便于直接看到现有教师
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasRole = (a: AccountRow, role: string) => (a.roles ?? []).includes(role);

  const toggleRole = async (a: AccountRow, role: string, enabled: boolean) => {
    if (busy) return;
    setBusy(`${a.user_id}:${role}`);
    setError('');
    setMsg('');
    const { error: e } = await supabase.rpc('admin_set_role', {
      p_email: a.email,
      p_role: role,
      p_enabled: enabled,
    });
    setBusy('');
    if (e) {
      setError(e.message);
      return;
    }
    setMsg(`${a.email}：${ROLE_LABEL[role] ?? role} ${enabled ? '已授予' : '已撤销'}`);
    await search();
    await loadClasses();
  };

  const assignTeacher = async (c: ClassRow, email: string) => {
    if (busy) return;
    setBusy(`class:${c.id}`);
    setError('');
    setMsg('');
    const { error: e } = await supabase.rpc('admin_set_class_teacher', {
      p_class_id: c.id,
      p_email: email.trim(),
    });
    setBusy('');
    if (e) {
      setError(e.message);
      return;
    }
    setMsg(email.trim() ? `班级「${c.name}」已交给 ${email.trim()}` : `班级「${c.name}」已解除归属`);
    await loadClasses();
  };

  return (
    <div className="card" style={{ marginTop: '0.8rem', marginBottom: '0.8rem' }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>账户与班级归属</h3>
        <span className="spacer" />
        <button className="ghost" onClick={() => void search()} disabled={loading}>
          {loading ? '检索中…' : '刷新'}
        </button>
      </div>
      <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
        给已注册账号授予「教师」后，该账号刷新页面即可看到教师后台。
        班级归属决定写权限：教师只能改自己任教的班和对应大纲的词条覆盖。
      </p>

      {error && (
        <div className="card" style={{ marginTop: '0.5rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
          操作失败：{error}
        </div>
      )}
      {msg && (
        <div className="card" style={{ marginTop: '0.5rem', background: 'var(--ok-bg)', borderColor: 'var(--ok)' }}>
          {msg}
        </div>
      )}

      <div className="row" style={{ marginTop: '0.8rem', gap: '0.5rem', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="按邮箱片段搜索，如 chensr 或 @student.dtd-edu.cn（留空列出前 60 个）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          style={{ flex: 1, maxWidth: '32rem' }}
        />
        <button className="primary" onClick={() => void search()} disabled={loading}>
          搜索
        </button>
      </div>

      {accounts.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: '0.8rem' }}>
          <table className="check-table">
            <thead>
              <tr>
                <th>邮箱</th>
                <th>角色</th>
                <th>任教班级</th>
                <th>最近登录</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.user_id}>
                  <td style={{ fontWeight: 600 }}>{a.email}</td>
                  <td>
                    <div className="row tight" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                      {(a.roles ?? []).length === 0 && <span className="muted">（无角色）</span>}
                      {(a.roles ?? []).map((r) => (
                        <span key={r} className={r === 'developer' ? 'badge warn' : r === 'teacher' ? 'badge success' : 'badge'}>
                          {ROLE_LABEL[r] ?? r}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {(a.class_names ?? []).length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <span>{(a.class_names ?? []).join('、')}</span>
                    )}
                  </td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                    {a.last_sign_in_at
                      ? new Date(a.last_sign_in_at).toLocaleDateString('zh-CN')
                      : '从未登录'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className={hasRole(a, 'teacher') ? 'ghost' : 'primary'}
                      disabled={busy === `${a.user_id}:teacher`}
                      onClick={() => void toggleRole(a, 'teacher', !hasRole(a, 'teacher'))}
                    >
                      {busy === `${a.user_id}:teacher`
                        ? '处理中…'
                        : hasRole(a, 'teacher')
                          ? '撤销教师'
                          : '设为教师'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 style={{ margin: '1rem 0 0.3rem' }}>班级归属</h4>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
        每行填教师邮箱后回车或点「指定」。留空并点「解除」= 该班暂无归属（只有开发者能改）。
      </p>
      {classes.length === 0 ? (
        <p className="muted">还没有班级。</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="check-table">
            <thead>
              <tr>
                <th>班级</th>
                <th>大纲</th>
                <th style={{ minWidth: '18rem' }}>任教教师</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <ClassAssignRow
                  key={c.id}
                  row={c}
                  busy={busy === `class:${c.id}`}
                  onAssign={(email) => void assignTeacher(c, email)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// 单行的邮箱输入框：受控于本地草稿，未保存前不污染列表数据。
function ClassAssignRow({
  row,
  busy,
  onAssign,
}: {
  row: ClassRow;
  busy: boolean;
  onAssign: (email: string) => void;
}) {
  const [draft, setDraft] = useState(row.teacherEmail ?? '');

  useEffect(() => {
    setDraft(row.teacherEmail ?? '');
  }, [row.teacherEmail]);

  return (
    <tr>
      <td style={{ fontWeight: 600 }}>{row.name}</td>
      <td>
        <span className="badge">{row.syllabus ?? '9699'}</span>
      </td>
      <td>
        <div className="row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {row.teacherEmail ? (
            <span className="badge success">{row.teacherEmail}</span>
          ) : (
            <span className="badge warn">未指定</span>
          )}
          <input
            type="text"
            placeholder="教师邮箱"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onAssign(draft); }}
            style={{ minWidth: '14rem' }}
          />
          <button className="primary" disabled={busy} onClick={() => onAssign(draft)}>
            {busy ? '保存中…' : '指定'}
          </button>
          <button className="ghost" disabled={busy || !row.teacherEmail} onClick={() => onAssign('')}>
            解除
          </button>
        </div>
      </td>
    </tr>
  );
}
