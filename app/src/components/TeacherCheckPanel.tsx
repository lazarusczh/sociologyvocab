import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isDayChecked, isInWrongBook } from '../lib/checkin';
import type { CloudStudentData } from '../lib/cloud';
import type { CheckInState, WrongBook } from '../lib/types';

// 云端 student_data 表的完整行（含 user_id / email / data / class_id）
interface StudentRow {
  user_id: string;
  email: string;
  data: CloudStudentData;
  class_id?: string | null;
  updated_at?: string;
}

// 班级
interface ClassRow {
  id: string;
  name: string;
}

// 单个学生的核验统计
interface StudentStat {
  user_id: string;
  email: string;
  name: string;
  className: string; // 班级名（未分班/班级不存在为空）
  classId: string;
  checkinDays: number;   // 累计打卡天数（含补签）
  bestStreak: number;    // 最长连续天数
  totalQuestions: number; // 累计正式练习题数
  accuracy: number;      // 总体正确率（0-100，无题记 0）
  wrongCount: number;    // 当前错题本条目数
  updatedAt: string;
}

// 统计单个学生（className 由外部传入）
function summarize(row: StudentRow, className: string): StudentStat {
  const d = row.data ?? ({} as CloudStudentData);
  const checkin: CheckInState = d.checkin ?? { study: {}, makeup: {}, earnedMakeupWeeks: [], bestStreak: 0 };
  const wrongBook: WrongBook = d.wrongBook ?? {};

  const checkedDays = new Set<string>();
  Object.keys(checkin.study).forEach((k) => {
    if (isDayChecked(checkin, k)) checkedDays.add(k);
  });
  Object.keys(checkin.makeup).forEach((k) => checkedDays.add(k));

  let totalQuestions = 0;
  let totalCorrect = 0;
  for (const s of Object.values(checkin.study)) {
    totalQuestions += s.questions;
    totalCorrect += s.correct;
  }
  const accuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;
  const wrongCount = Object.values(wrongBook).filter((e) => isInWrongBook(e)).length;

  return {
    user_id: row.user_id,
    email: row.email,
    name: d.name || '',
    className,
    classId: row.class_id ?? '',
    checkinDays: checkedDays.size,
    bestStreak: checkin.bestStreak ?? 0,
    totalQuestions,
    accuracy,
    wrongCount,
    updatedAt: row.updated_at ? new Date(row.updated_at).toLocaleString() : '',
  };
}

export default function TeacherCheckPanel() {
  const [rows, setRows] = useState<StudentStat[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classFilter, setClassFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    // 读取班级列表（用于显示班级名 + 筛选）
    const { data: classRows } = await supabase.from('classes').select('id, name').order('name');
    const classList = (classRows ?? []) as ClassRow[];
    const classMap = new Map(classList.map((c) => [c.id, c.name]));
    setClasses(classList);
    // 读取 developer 账号（统计默认排除，避免测试数据污染）
    const { data: devRows } = await supabase.from('user_roles').select('user_id').eq('role', 'developer');
    const devIds = new Set(((devRows ?? []) as { user_id: string }[]).map((d) => d.user_id));
    // 老师身份已通过 RLS 放行，此处用当前登录 session 读取全部学生
    const { data, error: err } = await supabase
      .from('student_data')
      .select('user_id, email, data, updated_at, class_id')
      .order('email', { ascending: true });
    if (err) {
      setError(err.message);
      setRows([]);
    } else {
      const filtered = ((data ?? []) as StudentRow[]).filter((r) => !devIds.has(r.user_id));
      setRows(filtered.map((r) => summarize(r, r.class_id ? (classMap.get(r.class_id) ?? '') : '')));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 按班级筛选
  const shown = useMemo(
    () => (classFilter === 'all' ? rows : rows.filter((r) => r.classId === classFilter)),
    [rows, classFilter],
  );

  const totalStudents = shown.length;
  const totalCheckins = shown.reduce((s, r) => s + r.checkinDays, 0);
  const totalQuestions = shown.reduce((s, r) => s + r.totalQuestions, 0);
  const avgAccuracy = totalQuestions > 0
    ? Math.round((shown.reduce((s, r) => s + r.totalQuestions * r.accuracy, 0) / totalQuestions))
    : 0;

  return (
    <div>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>学生打卡核验</h3>
          <span className="spacer" />
          <button className="ghost" onClick={load} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
        <p className="muted" style={{ marginTop: '0.4rem' }}>
          汇总所有已登录并同步的学生数据（已排除 developer/测试账号；离线未登录的记录不统计）。
        </p>
        {classes.length > 0 && (
          <div className="tag-filter" style={{ marginTop: '0.4rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>班级：</span>
            <button className={classFilter === 'all' ? 'active' : ''} onClick={() => setClassFilter('all')}>
              全部
            </button>
            {classes.map((c) => (
              <button key={c.id} className={classFilter === c.id ? 'active' : ''} onClick={() => setClassFilter(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        <div className="grid cols-4" style={{ marginTop: '0.6rem' }}>
          <div className="stat"><span className="num">{totalStudents}</span><span className="label">学生数</span></div>
          <div className="stat"><span className="num">{totalCheckins}</span><span className="label">累计打卡</span></div>
          <div className="stat"><span className="num">{totalQuestions}</span><span className="label">累计题数</span></div>
          <div className="stat"><span className="num">{avgAccuracy}%</span><span className="label">平均正确率</span></div>
        </div>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: '0.8rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
          读取学生数据失败：{error}
        </div>
      )}

      {!loading && !error && shown.length === 0 && (
        <div className="card"><div className="empty-state">
          <div className="big">📋</div>
          <p className="muted">暂无学生数据。学生登录并同步后会自动出现在这里。</p>
        </div></div>
      )}

      {shown.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="check-table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>班级</th>
                <th>邮箱</th>
                <th>累计打卡</th>
                <th>最长连续</th>
                <th>累计题数</th>
                <th>正确率</th>
                <th>错题数</th>
                <th>最近同步</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.user_id}>
                  <td>{r.name || '—'}</td>
                  <td>{r.className || '—'}</td>
                  <td className="muted">{r.email}</td>
                  <td>{r.checkinDays}</td>
                  <td>{r.bestStreak}</td>
                  <td>{r.totalQuestions}</td>
                  <td>{r.accuracy}%</td>
                  <td>{r.wrongCount}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{r.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
