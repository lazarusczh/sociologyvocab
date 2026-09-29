import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isDayChecked, isInWrongBook, todayKey, FULL_ATTENDANCE_DAYS } from '../lib/checkin';
import { fetchAllServerCheckIn } from '../lib/checkinServer';
import { isServerCheckinEnabled } from '../lib/checkinMode';
import { useClassXpSummary } from '../lib/xpSummary';
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

// 全勤奖线（当月达标 ≥28 天）已收敛到 `lib/checkin.ts` 的 `FULL_ATTENDANCE_DAYS`，
// 与打卡页共用一份 —— 之前这里另写了一个字面量，调阈值时必然漏掉一处。

const emptyCheckin = (): CheckInState => ({ study: {}, makeup: {}, earnedMakeupWeeks: [], bestStreak: 0 });

// 月度榜单只列前 N 名（§4.5.4：只列获奖者与榜单前几名，避免打击后进）。
// 完整名单在下方核验表里 —— 教师核验需要看全量，而"公布"只需要前几名。
const BOARD_TOP_N = 10;

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
  // 服务端口径打卡（第④步切换后用它替代本地 checkin）。空 Map = 未启用或未取到。
  const [serverCheckin, setServerCheckin] = useState<Map<string, CheckInState>>(new Map());
  const [serverError, setServerError] = useState('');
  const useServerCheckin = isServerCheckinEnabled();

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
      // 保留原始行：月度视图需要原始的 checkin（累计统计会把逐日明细丢掉），
      // 且姓名、错题本、班级仍以本地 `student_data` 为源 —— 服务端没有这些。
      setRawRows(((data ?? []) as StudentRow[]).filter((r) => !devIds.has(r.user_id)));
    }
    // 打卡判定已切服务端时，**再拉一份服务端口径**：
    // 学生看到的是服务端判定，教师核验必须与之一致，否则会出现
    // 「学生界面达标、教师核验未达标」这种师生口径分裂。
    if (useServerCheckin) {
      try {
        setServerCheckin(await fetchAllServerCheckIn());
        setServerError('');
      } catch (e) {
        // 取不到就退回本地口径，但**必须显式提示** —— 教师据此发奖，不能默默用错口径。
        setServerError(e instanceof Error ? e.message : String(e));
        setServerCheckin(new Map());
      }
    }
    setLoading(false);
  }, [useServerCheckin]);

  useEffect(() => {
    load();
  }, [load]);

  // 打卡口径来源：切换后优先服务端（与学生在打卡页看到的一致），否则本地。
  // ⚠ **只替换 `checkin`** —— 姓名、错题本、班级仍来自本地 `student_data`（服务端没有这些）。
  //   所以这里是"混合来源"，而不是把整行换成服务端数据。
  const effectiveRows = useMemo(
    () =>
      rawRows.map((r) => {
        const sv = serverCheckin.get(r.user_id);
        if (!useServerCheckin || !sv) return r;
        return { ...r, data: { ...r.data, checkin: sv } };
      }),
    [rawRows, serverCheckin, useServerCheckin],
  );

  // 累计统计（口径与改造前完全一致）
  const rows = useMemo(
    () => effectiveRows.map((r) => summarize(r, r.class_id ? (classMap.get(r.class_id) ?? '') : '', validIds)),
    [effectiveRows, classMap, validIds],
  );

  // 数据里出现过的月份（倒序）—— 月度视图的可选项
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const r of effectiveRows) {
      const ci = r.data?.checkin;
      for (const k of Object.keys(ci?.study ?? {})) set.add(k.slice(0, 7));
      for (const k of Object.keys(ci?.makeup ?? {})) set.add(k.slice(0, 7));
    }
    return [...set].sort().reverse();
  }, [effectiveRows]);

  const isMonthView = periodFilter !== 'all';

  // 按班级筛选（原始行，月度视图要用）—— 用 effectiveRows，让月度视图也走同一口径
  const shownRaw = useMemo(
    () => (classFilter === 'all' ? effectiveRows : effectiveRows.filter((r) => (r.class_id ?? '') === classFilter)),
    [effectiveRows, classFilter],
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

  // ---- 月度榜单（§4.5.4）----
  // 数据源是 staff-only 的 `get_xp_summary_all`：一次拿全班（逐人调用要 20 次往返）。
  // ⚠ 只在**月度口径**下请求 —— 累计口径没有「本月增长」这个概念，发了也是白花一次往返。
  const classXp = useClassXpSummary(isMonthView ? periodFilter : null);

  // 把 XP 行与本地那份名单拼起来：姓名/班级仍以 `student_data` 为源（服务端那份没有姓名），
  // 并按班级筛选对齐 —— 否则切到某个班时，榜单还列着全班的人。
  const board = useMemo(() => {
    if (!isMonthView) return [];
    const byId = new Map(shownRaw.map((r) => [r.user_id, r]));
    return classXp.rows
      .filter((x) => byId.has(x.user_id))
      .map((x) => {
        const r = byId.get(x.user_id)!;
        const st = monthStats.get(x.user_id);
        return {
          user_id: x.user_id,
          name: r.data?.name || maskEmail(r.email) || '(未命名)',
          xp: x.range_xp,
          bonus: x.bonus_range,
          checkedDays: st?.checkedDays ?? 0,
          fullAttendance: !!st?.fullAttendance,
          // 「本月新加入」由服务端给的年月直判（时区折算只有服务端那一份，见 ClassXpRow）
          isNew: x.joined_month === periodFilter,
        };
      })
      // 并列时用「本月打卡天数」再排（§4.5.1 的并列处理：XP 并列则以打卡天数多者优先），
      // 仍并列再按姓名，保证顺序**稳定**（否则每次刷新名次都在跳，教师没法对照）。
      .sort((a, b) => b.xp - a.xp || b.checkedDays - a.checkedDays || a.name.localeCompare(b.name))
      .slice(0, BOARD_TOP_N);
  }, [isMonthView, periodFilter, classXp.rows, shownRaw, monthStats]);

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

      {serverError && (
        <div className="card" style={{ marginBottom: '0.8rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
          <strong>当前显示的是本机口径，不是服务端口径。</strong>
          <div style={{ fontSize: '0.85rem', marginTop: '0.3rem' }}>
            读取服务端打卡失败（{serverError}）。学生界面走的是服务端判定，
            所以此刻两边可能不一致 —— 发奖前请先解决这个问题，不要用当前数字下结论。
          </div>
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

      {/* 月度榜单（§4.5.4）：按「本月 XP 增长」降序。
          ⚠ 只在月度口径下显示 —— 累计口径没有「本月增长」这个概念。
          ⚠ 只列前 N 名：§4.5.4 要求「不展示未达标名单、只列获奖者与榜单前几名」，
            完整名单在**下方**核验表里（教师核验要看全量，而"公布"只需前几名）。
          ⚠⚠ **额外绑 `useServerCheckin`（判定切换开关）**：不绑的话，切换生效前它是
            「**服务端 XP + 本地打卡天数**」的混合口径 —— 两个数各自都对，但并排看会被
            误读成 bug（「XP 是 0，打卡却有 5 天」）。绑上之后整块 XP 体系**同一时刻生效**，
            与 `XpCard` / 加分卡入口 / 打卡判定的门控保持一致。
            开发环境仍可用 `checkinMode` 的 dev 开关预览（见该文件注释）。 */}
      {isMonthView && useServerCheckin && (
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>{periodFilter} 月度榜单</h3>
            <span className="spacer" />
            <button className="ghost" onClick={classXp.reload} disabled={classXp.loading}>
              {classXp.loading ? '加载中…' : '刷新'}
            </button>
          </div>
          <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
            按<strong>本月 XP 增长</strong>降序（<strong>含</strong>教师签发的奖励 XP）。
            月度之星 = 本月增长最高者（1 名）；全勤奖 = 本月打卡 ≥{FULL_ATTENDANCE_DAYS} 天（不限名额）。
            只列前 {BOARD_TOP_N} 名，完整名单见下方核验表。
          </p>
          {classXp.error && (
            <p className="badge warn" style={{ marginTop: '0.5rem' }}>XP 读取失败：{classXp.error}</p>
          )}
          {!classXp.error && !classXp.loading && board.length === 0 && (
            <p className="empty-state" style={{ marginTop: '0.5rem' }}>该月还没有 XP 记录。</p>
          )}
          {board.length > 0 && (
            <div style={{ padding: 0, overflowX: 'auto', marginTop: '0.5rem' }}>
              <table className="check-table">
                <thead>
                  <tr>
                    <th>名次</th>
                    <th>学生</th>
                    <th>本月 XP 增长</th>
                    <th>其中奖励</th>
                    <th>本月打卡</th>
                    <th>全勤</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((b, i) => (
                    <tr key={b.user_id}>
                      <td>{i + 1}</td>
                      <td>{b.name}</td>
                      <td style={{ fontWeight: 600 }}>{b.xp}</td>
                      <td className="muted">{b.bonus > 0 ? `+${b.bonus}` : '—'}</td>
                      <td>{b.checkedDays} 天</td>
                      <td>
                        {b.fullAttendance
                          ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>达标</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td>
                        {b.isNew && <span className="badge warn">本月新加入·次月参评</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
