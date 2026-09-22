import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isDayChecked, isInWrongBook, todayKey } from '../lib/checkin';
import { useStore } from '../lib/store';
import { maskEmail } from '../lib/shuffle';
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

// 单个学生的核验统计（**累计**口径）
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

// 单个学生在**某自然月**的统计（月度口径，供全勤奖/月度之星核验）
interface MonthStat {
  checkedDays: number;    // 该月达标天数（含补签）
  questions: number;
  correct: number;        // 保留原始答对数：顶部汇总要按题数加权求平均正确率
  accuracy: number;
  makeupDays: number;     // 其中「纯补签」的天数（当天没有练习记录、靠补签达标）
  fullAttendance: boolean; // 是否达全勤线（核验用）
}

// 全勤奖线（与《练级与奖励体系方案》4.5 一致：当月打卡 ≥28 天）
const FULL_ATTENDANCE_DAYS = 28;

const emptyCheckin = (): CheckInState => ({ study: {}, makeup: {}, earnedMakeupWeeks: [], bestStreak: 0 });

// 统计单个学生（className 由外部传入）
function summarize(row: StudentRow, className: string, validIds: Set<string>): StudentStat {
  const d = row.data ?? ({} as CloudStudentData);
  const checkin: CheckInState = d.checkin ?? emptyCheckin();
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
  const wrongCount = Object.entries(wrongBook).filter(([id, e]) => validIds.has(id) && isInWrongBook(e)).length;

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

/**
 * 某自然月（ym = 'YYYY-MM'）的统计。
 * 注意：达标天数必须把 `makeup` 里的日子也算进来 —— 补签日可能**完全没有** `study` 记录，
 * 只遍历 study 会漏掉它们。纯补签天单独计数（makeupDays），便于核验时区分
 * 「真的练了」与「靠补签补上的」。
 */
function summarizeMonth(checkin: CheckInState, ym: string): MonthStat {
  const keys = new Set<string>();
  for (const k of Object.keys(checkin.study)) if (k.startsWith(ym)) keys.add(k);
  for (const k of Object.keys(checkin.makeup)) if (k.startsWith(ym)) keys.add(k);

  let questions = 0;
  let correct = 0;
  let checkedDays = 0;
  let makeupDays = 0;
  for (const k of keys) {
    const s = checkin.study[k];
    if (s) { questions += s.questions; correct += s.correct; }
    if (isDayChecked(checkin, k)) {
      checkedDays++;
      if (!s || s.questions === 0) makeupDays++; // 纯补签
    }
  }
  return {
    checkedDays,
    questions,
    correct,
    accuracy: questions > 0 ? Math.round((correct / questions) * 100) : 0,
    makeupDays,
    fullAttendance: checkedDays >= FULL_ATTENDANCE_DAYS,
  };
}

/**
 * 月度日历格（该月一天一格，**三态**）。
 *
 * 为什么要三态而不是「打了/没打」：实测中约 45% 的练习日**有作答但没够线**
 * （10 分钟 + 20 题），那与「整天没练」是完全不同的行为。核验全勤时把两者混为一谈，
 * 会误判学生的学习态度，所以这里刻意用三种颜色分开表达。
 */
function MonthGrid({ checkin, ym }: { checkin: CheckInState; ym: string }) {
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = todayKey();
  const cells = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${ym}-${String(d).padStart(2, '0')}`;
    if (key > today) {
      cells.push(<span key={d} className="mg-cell mg-future" title={`${d} 日：未到`} />);
      continue;
    }
    const s = checkin.study[key];
    if (isDayChecked(checkin, key)) {
      const pureMakeup = !!checkin.makeup[key] && (!s || s.questions === 0);
      const detail = s && s.questions > 0 ? `（${s.questions} 题 / ${Math.floor(s.seconds / 60)} 分钟）` : '';
      cells.push(
        <span
          key={d}
          className={`mg-cell ${pureMakeup ? 'mg-makeup' : 'mg-ok'}`}
          title={`${d} 日：${pureMakeup ? '补签' : '已达标'}${detail}`}
        />,
      );
    } else if (s) {
      cells.push(
        <span
          key={d}
          className="mg-cell mg-partial"
          title={`${d} 日：有练习但未达标（${s.questions} 题 / ${Math.floor(s.seconds / 60)} 分钟）`}
        />,
      );
    } else {
      cells.push(<span key={d} className="mg-cell mg-none" title={`${d} 日：无记录`} />);
    }
  }
  return <div className="mg-wrap">{cells}</div>;
}

export default function TeacherCheckPanel() {
  const { vocab } = useStore();
  const validIds = useMemo(() => new Set(vocab.map((v) => v.id)), [vocab]);
  const [rawRows, setRawRows] = useState<StudentRow[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classMap, setClassMap] = useState<Map<string, string>>(new Map());
  const [classFilter, setClassFilter] = useState<string>('all');
  /** 'all' = 累计口径；'YYYY-MM' = 该自然月口径 */
  const [periodFilter, setPeriodFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    // 读取班级列表（用于显示班级名 + 筛选）
    const { data: classRows } = await supabase.from('classes').select('id, name').order('name');
    const classList = (classRows ?? []) as ClassRow[];
    setClasses(classList);
    setClassMap(new Map(classList.map((c) => [c.id, c.name])));
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
      setRawRows([]);
    } else {
      // 保留原始行：月度视图需要原始的 checkin（累计统计会把逐日明细丢掉）
      setRawRows(((data ?? []) as StudentRow[]).filter((r) => !devIds.has(r.user_id)));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 累计统计（口径与改造前完全一致）
  const rows = useMemo(
    () => rawRows.map((r) => summarize(r, r.class_id ? (classMap.get(r.class_id) ?? '') : '', validIds)),
    [rawRows, classMap, validIds],
  );

  // 数据里出现过的月份（倒序）—— 月度视图的可选项
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) {
      const ci = r.data?.checkin;
      for (const k of Object.keys(ci?.study ?? {})) set.add(k.slice(0, 7));
      for (const k of Object.keys(ci?.makeup ?? {})) set.add(k.slice(0, 7));
    }
    return [...set].sort().reverse();
  }, [rawRows]);

  const isMonthView = periodFilter !== 'all';

  // 按班级筛选（原始行，月度视图要用）
  const shownRaw = useMemo(
    () => (classFilter === 'all' ? rawRows : rawRows.filter((r) => (r.class_id ?? '') === classFilter)),
    [rawRows, classFilter],
  );
  const rawById = useMemo(() => new Map(shownRaw.map((r) => [r.user_id, r])), [shownRaw]);
  // 按班级筛选（统计行，累计视图要用）
  const shown = useMemo(
    () => (classFilter === 'all' ? rows : rows.filter((r) => r.classId === classFilter)),
    [rows, classFilter],
  );

  // 月度统计
  const monthStats = useMemo(() => {
    const m = new Map<string, MonthStat>();
    if (!isMonthView) return m;
    for (const r of shownRaw) m.set(r.user_id, summarizeMonth(r.data?.checkin ?? emptyCheckin(), periodFilter));
    return m;
  }, [shownRaw, periodFilter, isMonthView]);

  const totalStudents = shown.length;

  // 顶部汇总：随口径切换
  const summary = useMemo(() => {
    if (!isMonthView) {
      const checkins = shown.reduce((s, r) => s + r.checkinDays, 0);
      const questions = shown.reduce((s, r) => s + r.totalQuestions, 0);
      const acc = questions > 0
        ? Math.round(shown.reduce((s, r) => s + r.totalQuestions * r.accuracy, 0) / questions)
        : 0;
      return {
        a: { n: String(checkins), label: '累计打卡' },
        b: { n: String(questions), label: '累计题数' },
        c: { n: `${acc}%`, label: '平均正确率' },
      };
    }
    let checkins = 0;
    let questions = 0;
    let correct = 0;
    let fullCount = 0;
    for (const r of shownRaw) {
      const st = monthStats.get(r.user_id);
      if (!st) continue;
      checkins += st.checkedDays;
      questions += st.questions;
      correct += st.correct;
      if (st.fullAttendance) fullCount++;
    }
    const acc = questions > 0 ? Math.round((correct / questions) * 100) : 0;
    return {
      a: { n: String(checkins), label: '本月打卡' },
      b: { n: String(fullCount), label: `达全勤（≥${FULL_ATTENDANCE_DAYS} 天）` },
      c: { n: `${acc}%`, label: '平均正确率' },
    };
  }, [isMonthView, shown, shownRaw, monthStats]);

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
        {months.length > 0 && (
          <div className="tag-filter" style={{ marginTop: '0.4rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>口径：</span>
            <button className={periodFilter === 'all' ? 'active' : ''} onClick={() => setPeriodFilter('all')}>
              累计
            </button>
            {months.map((m) => (
              <button key={m} className={periodFilter === m ? 'active' : ''} onClick={() => setPeriodFilter(m)}>
                {m}
              </button>
            ))}
          </div>
        )}
        <div className="grid cols-4" style={{ marginTop: '0.6rem' }}>
          <div className="stat"><span className="num">{totalStudents}</span><span className="label">学生数</span></div>
          <div className="stat"><span className="num">{summary.a.n}</span><span className="label">{summary.a.label}</span></div>
          <div className="stat"><span className="num">{summary.b.n}</span><span className="label">{summary.b.label}</span></div>
          <div className="stat"><span className="num">{summary.c.n}</span><span className="label">{summary.c.label}</span></div>
        </div>
        {isMonthView && months.length > 0 && (
          <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
            日历格：<span className="mg-cell mg-ok" style={{ verticalAlign: 'middle' }} /> 已达标 ·
            <span className="mg-cell mg-makeup" style={{ verticalAlign: 'middle', marginLeft: 6 }} /> 补签 ·
            <span className="mg-cell mg-partial" style={{ verticalAlign: 'middle', marginLeft: 6 }} /> 有练习但未达标 ·
            <span className="mg-cell mg-none" style={{ verticalAlign: 'middle', marginLeft: 6 }} /> 无记录
          </p>
        )}
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
                {isMonthView ? (
                  <>
                    <th>本月打卡</th>
                    <th>本月题数</th>
                    <th>正确率</th>
                    <th>全勤</th>
                    <th>日历（{periodFilter}）</th>
                  </>
                ) : (
                  <>
                    <th>累计打卡</th>
                    <th>最长连续</th>
                    <th>累计题数</th>
                    <th>正确率</th>
                    <th>错题数</th>
                    <th>最近同步</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const st = monthStats.get(r.user_id);
                const raw = rawById.get(r.user_id);
                return (
                  <tr key={r.user_id}>
                    <td>{r.name || '—'}</td>
                    <td>{r.className || '—'}</td>
                    <td className="muted">{maskEmail(r.email)}</td>
                    {isMonthView && st ? (
                      <>
                        <td>
                          {st.checkedDays}
                          {st.makeupDays > 0 && (
                            <span className="muted" style={{ fontSize: '0.75rem' }}>（补签 {st.makeupDays}）</span>
                          )}
                        </td>
                        <td>{st.questions}</td>
                        <td>{st.accuracy}%</td>
                        <td>
                          {st.fullAttendance
                            ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>✓ 达标</span>
                            : <span className="muted">—</span>}
                        </td>
                        <td>
                          <MonthGrid checkin={raw?.data?.checkin ?? emptyCheckin()} ym={periodFilter} />
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{r.checkinDays}</td>
                        <td>{r.bestStreak}</td>
                        <td>{r.totalQuestions}</td>
                        <td>{r.accuracy}%</td>
                        <td>{r.wrongCount}</td>
                        <td className="muted" style={{ fontSize: '0.8rem' }}>{r.updatedAt}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
