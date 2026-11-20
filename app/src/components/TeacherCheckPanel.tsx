import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isDayChecked, isInWrongBook, todayKey, FULL_ATTENDANCE_DAYS, weekStartKey, parseKey, dateKeyOf, addDays } from '../lib/checkin';
import { fetchAllServerCheckIn } from '../lib/checkinServer';
import { isServerCheckinEnabled } from '../lib/checkinMode';
import { useClassXpSummary } from '../lib/xpSummary';
import { useMonthAwards, setAwardRecord, awardKey, AWARD_LABEL, AWARD_HINT } from '../lib/awards';
import type { AwardKind } from '../lib/awards';
import { useStore } from '../lib/store';
import { maskEmail } from '../lib/shuffle';
import ScrollText from './ScrollText';
import { listStaffIds } from '../lib/cloud';
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

// 获奖记录的展示顺序（§4.5.1：月度之星在前，全勤奖在后）。
const AWARD_ORDER: AwardKind[] = ['star', 'full_attendance'];

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

/** 某自然月的全部日期键（'YYYY-MM' → 28~31 个键） */
function daysOfMonth(ym: string): string[] {
  const [y, m] = ym.split('-').map(Number);
  const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
}

/** 某自然周的全部日期键（周一 → 周日）；入参是周一那天的键 */
function daysOfWeek(weekStart: string): string[] {
  const base = parseKey(weekStart);
  return Array.from({ length: 7 }, (_, i) => dateKeyOf(addDays(base, i)));
}

/**
 * 一段日期（自然月 / 自然周）的统计。
 * 注意：达标天数必须把 `makeup` 里的日子也算进来 —— 补签日可能**完全没有** `study` 记录，
 * 只遍历 study 会漏掉它们。纯补签天单独计数（makeupDays），便于核验时区分
 * 「真的练了」与「靠补签补上的」。
 */
function summarizeDays(checkin: CheckInState, days: string[]): MonthStat {
  let questions = 0;
  let correct = 0;
  let checkedDays = 0;
  let makeupDays = 0;
  for (const k of days) {
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

const WEEKDAY_LABEL = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 日期格（一天一格，**三态**），自然月与自然周共用。
 *
 * 为什么要三态而不是「打了/没打」：实测中约 45% 的练习日**有作答但没够线**
 * （10 分钟 + 20 题），那与「整天没练」是完全不同的行为。核验全勤时把两者混为一谈，
 * 会误判学生的学习态度，所以这里刻意用三种颜色分开表达。
 *
 * `weekday=true`（周视图）时在格子上方补一行「一二三四五六日」，否则 7 个方格
 * 无法判断哪格是哪天。
 */
function PeriodGrid({ checkin, days, weekday = false }: { checkin: CheckInState; days: string[]; weekday?: boolean }) {
  const today = todayKey();
  const cells = days.map((key) => {
    const d = Number(key.slice(8));
    const [, mm] = key.split('-').slice(1).map(Number);
    const wd = WEEKDAY_LABEL[(parseKey(key).getDay() + 6) % 7]; // 周一=0 … 周日=6
    const label = weekday ? `${mm}月${d}日（周${wd}）` : `${d} 日`;
    if (key > today) {
      return <span key={key} className="mg-cell mg-future" title={`${label}：未到`} />;
    }
    const s = checkin.study[key];
    if (isDayChecked(checkin, key)) {
      const pureMakeup = !!checkin.makeup[key] && (!s || s.questions === 0);
      const detail = s && s.questions > 0 ? `（${s.questions} 题 / ${Math.floor(s.seconds / 60)} 分钟）` : '';
      return (
        <span
          key={key}
          className={`mg-cell ${pureMakeup ? 'mg-makeup' : 'mg-ok'}`}
          title={`${label}：${pureMakeup ? '补签' : '已达标'}${detail}`}
        />
      );
    }
    if (s) {
      return (
        <span
          key={key}
          className="mg-cell mg-partial"
          title={`${label}：有练习但未达标（${s.questions} 题 / ${Math.floor(s.seconds / 60)} 分钟）`}
        />
      );
    }
    return <span key={key} className="mg-cell mg-none" title={`${label}：无记录`} />;
  });

  if (!weekday) return <div className="mg-wrap">{cells}</div>;
  return (
    <div className="mg-week">
      <div className="mg-weekdays">
        {WEEKDAY_LABEL.map((w) => <span key={w}>{w}</span>)}
      </div>
      <div className="mg-wrap">{cells}</div>
    </div>
  );
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
    // 读取教职工账号（teacher + developer）：打卡核验只查学生记录，
    // 教师登录时在 student_data 留下的空行必须排除，否则会被当成零打卡的学生。
    let staffIds = new Set<string>();
    try {
      staffIds = new Set(await listStaffIds());
    } catch {
      // 取不到角色就退回只排除 developer 的旧口径，但不要因此让整个面板打不开
      const { data: devRows } = await supabase.from('user_roles').select('user_id').eq('role', 'developer');
      staffIds = new Set(((devRows ?? []) as { user_id: string }[]).map((d) => d.user_id));
    }
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
      setRawRows(((data ?? []) as StudentRow[]).filter((r) => !staffIds.has(r.user_id)));
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

  // 口径三态：'all'（累计）| 'YYYY-MM'（自然月）| 'W:YYYY-MM-DD'（该日所在自然周的周一）
  const isMonthView = /^\d{4}-\d{2}$/.test(periodFilter);
  const isWeekView = periodFilter.startsWith('W:');
  const isPeriodView = isMonthView || isWeekView;
  // 周视图当前展示的那一周；不在周视图时以「本周」为基准（点箭头即从本周开始走）
  const shownWeekStart = isWeekView ? periodFilter.slice(2) : weekStartKey(new Date());
  const periodDays = useMemo(
    () => (isMonthView ? daysOfMonth(periodFilter) : isWeekView ? daysOfWeek(shownWeekStart) : []),
    [isMonthView, isWeekView, periodFilter, shownWeekStart],
  );

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

  // 月 / 周统计（同一套算法，只是传入的日期段不同）
  const periodStats = useMemo(() => {
    const m = new Map<string, MonthStat>();
    if (!isPeriodView) return m;
    for (const r of shownRaw) m.set(r.user_id, summarizeDays(r.data?.checkin ?? emptyCheckin(), periodDays));
    return m;
  }, [shownRaw, periodDays, isPeriodView]);

  const totalStudents = shown.length;

  // 顶部汇总：随口径切换
  const summary = useMemo(() => {
    if (!isPeriodView) {
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
      const st = periodStats.get(r.user_id);
      if (!st) continue;
      checkins += st.checkedDays;
      questions += st.questions;
      correct += st.correct;
      if (st.fullAttendance) fullCount++;
    }
    const acc = questions > 0 ? Math.round((correct / questions) * 100) : 0;
    return {
      a: { n: String(checkins), label: isWeekView ? '本周打卡' : '本月打卡' },
      // 全勤线是**月度**口径（≥28 天），周视图里没有对应阈值 ⇒ 第二格改看本周题数
      b: isWeekView
        ? { n: String(questions), label: '本周题数' }
        : { n: String(fullCount), label: `达全勤（≥${FULL_ATTENDANCE_DAYS} 天）` },
      c: { n: `${acc}%`, label: '平均正确率' },
    };
  }, [isPeriodView, isWeekView, shown, shownRaw, periodStats]);

  // ---- 月度榜单（§4.5.4）----
  // 数据源是 staff-only 的 `get_xp_summary_all`：一次拿全班（逐人调用要 20 次往返）。
  // ⚠ 只在**月度口径**下请求 —— 累计口径没有「本月增长」这个概念，发了也是白花一次往返。
  const classXp = useClassXpSummary(isMonthView ? periodFilter : null);

  // ---- 获奖记录（§4.5.4 第 2~3 步：核验后落库、勾「已发放」防重复）----
  // ⚠ 与榜单同样的门控：只在月度口径 + 切换生效后请求。
  // ⚠ 只读**该月**的记录（一年十几行），不必全量拉。
  const awards = useMonthAwards(isMonthView ? periodFilter : null, isMonthView && useServerCheckin);
  // 正在写的那一格（`uid:award`），用于禁用该格的复选框并显示进度。
  // ⚠ 按**格**而不是按行禁用：同一行的「月度之星」与「全勤奖」是两件互不相干的事，
  //   一起禁用会让教师以为必须等前一个写完才能动下一个。
  const [awardBusy, setAwardBusy] = useState('');
  const [awardMsg, setAwardMsg] = useState('');

  // 把 XP 行与本地那份名单拼起来：姓名/班级仍以 `student_data` 为源（服务端那份没有姓名），
  // 并按班级筛选对齐 —— 否则切到某个班时，榜单还列着全班的人。
  const board = useMemo(() => {
    if (!isMonthView) return [];
    const byId = new Map(shownRaw.map((r) => [r.user_id, r]));
    return classXp.rows
      .filter((x) => byId.has(x.user_id))
      .map((x) => {
        const r = byId.get(x.user_id)!;
        const st = periodStats.get(x.user_id);
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
  }, [isMonthView, periodFilter, classXp.rows, shownRaw, periodStats]);

  // ---- 获奖记录的两个操作（§4.5.4）----
  // ⚠ 「撤销已发放」与「撤销获奖」是**两件事**，走的是不同的 state：
  //   · 取消勾选「已发放」→ 'awarded'（清掉 delivered_at，**保留获奖记录**）
  //     —— 奖品还没交出去、或发错了要撤回，但这个人确实该获奖；
  //   · 取消勾选「获奖」→ 'none'（删掉整条记录）
  //     —— 这个人根本不该在名单里。
  //   合成一个动作的话，「撤回发错的奖品」会把获奖记录也一起抹掉。
  const applyAward = async (
    b: { user_id: string; name: string },
    k: AwardKind,
    state: 'awarded' | 'delivered' | 'none',
  ) => {
    if (!periodFilter) return;
    const key = awardKey(b.user_id, k);
    setAwardBusy(key);
    setAwardMsg('');
    try {
      await setAwardRecord(periodFilter, b.user_id, k, state);
      const what = AWARD_LABEL[k];
      setAwardMsg(
        state === 'none'
          ? `已撤销 ${b.name} 的${what}`
          : state === 'delivered'
            ? `已记录 ${b.name} 的${what}（已发放）`
            : `已把 ${b.name} 列为${what}（待发放）`,
      );
      awards.reload();
    } catch (e) {
      // 失败原因都是「参数/权限/目标不对」这类调用方问题，原文最有用
      setAwardMsg(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAwardBusy('');
    }
  };

  // ---- 自然周导航（周一至周日）----
  const shiftWeek = (delta: number) => {
    setPeriodFilter(`W:${dateKeyOf(addDays(parseKey(shownWeekStart), delta * 7))}`);
  };
  const currentWeekStart = weekStartKey(new Date());
  const weekDaysShown = daysOfWeek(shownWeekStart);
  const weekRangeShort = `${weekDaysShown[0].slice(5).replace('-', '/')}–${weekDaysShown[6].slice(5).replace('-', '/')}`;
  const weekRangeFull = `${weekDaysShown[0]} ~ ${weekDaysShown[6]}`;

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
        {/* 自然周：周一至周日。箭头一按就切进周口径，基准是当前正在看的那一周（不在周口径时=本周）。 */}
        {months.length > 0 && (
          <div className="tag-filter" style={{ marginTop: '0.4rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>自然周：</span>
            <button onClick={() => shiftWeek(-1)} title="上一周" aria-label="上一周">‹</button>
            <button
              className={isWeekView ? 'active' : ''}
              onClick={() => setPeriodFilter(`W:${shownWeekStart}`)}
              title={`${weekRangeFull}（周一至周日）`}
            >
              {weekRangeShort}
            </button>
            <button onClick={() => shiftWeek(1)} title="下一周" aria-label="下一周">›</button>
            <button
              className={isWeekView && shownWeekStart === currentWeekStart ? 'active' : ''}
              onClick={() => setPeriodFilter(`W:${currentWeekStart}`)}
              title={currentWeekStart}
            >
              本周
            </button>
          </div>
        )}
        <div className="grid cols-4" style={{ marginTop: '0.6rem' }}>
          <div className="stat"><span className="num">{totalStudents}</span><span className="label">学生数</span></div>
          <div className="stat"><span className="num">{summary.a.n}</span><span className="label">{summary.a.label}</span></div>
          <div className="stat"><span className="num">{summary.b.n}</span><span className="label">{summary.b.label}</span></div>
          <div className="stat"><span className="num">{summary.c.n}</span><span className="label">{summary.c.label}</span></div>
        </div>
        {isPeriodView && months.length > 0 && (
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
                {isPeriodView ? (
                  <>
                    <th>{isWeekView ? '本周打卡' : '本月打卡'}</th>
                    <th>{isWeekView ? '本周题数' : '本月题数'}</th>
                    <th>正确率</th>
                    {isMonthView && <th>全勤</th>}
                    <th>{isWeekView ? `日历（${weekRangeShort}）` : `日历（${periodFilter}）`}</th>
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
                const st = periodStats.get(r.user_id);
                const raw = rawById.get(r.user_id);
                return (
                  <tr key={r.user_id}>
                    <td><ScrollText text={r.name || '—'} /></td>
                    <td>{r.className || '—'}</td>
                    <td className="muted">{maskEmail(r.email)}</td>
                    {isPeriodView && st ? (
                      <>
                        <td>
                          {st.checkedDays}
                          {st.makeupDays > 0 && (
                            <span className="muted" style={{ fontSize: '0.75rem' }}>（补签 {st.makeupDays}）</span>
                          )}
                        </td>
                        <td>{st.questions}</td>
                        <td>{st.accuracy}%</td>
                        {isMonthView && (
                          <td>
                            {st.fullAttendance
                              ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>✓ 达标</span>
                              : <span className="muted">—</span>}
                          </td>
                        )}
                        <td>
                          <PeriodGrid checkin={raw?.data?.checkin ?? emptyCheckin()} days={periodDays} weekday={isWeekView} />
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
          {/* 获奖记录（§4.5.4 第 2~3 步）。
              ⚠ 两个开关的**语义不同**，别合并：点「获奖」= 记入名单（学生端立刻可见）；
                「已发放」= 奖品已交到手上（防重复发放）。撤回「已发放」只清发放时间、
                **保留获奖记录** —— 要删整条记录请关掉「获奖」。 */}
          <p className="muted" style={{ marginTop: '0.2rem', marginBottom: 0, fontSize: '0.8rem' }}>
            发奖顺序：先点「获奖」记入名单（学生端立刻可见），交完奖品再点「已发放」防重复；
            撤回发放不会删除获奖记录。发放实物前请先核验候选数据。
          </p>
          {awards.error && (
            <p className="badge warn" style={{ marginTop: '0.5rem' }}>获奖记录读取失败：{awards.error}</p>
          )}
          {(awards.total > 0 || awardMsg) && (
            <p style={{ marginTop: '0.4rem', fontSize: '0.85rem', margin: '0.4rem 0 0' }}>
              {awards.total > 0 && (
                <>
                  本月已列：月度之星 <strong>{awards.starCount}</strong> 名
                  {awards.starCount > 1 && (
                    <span className="badge warn" style={{ marginLeft: '0.3rem' }}>超过 1 名，请确认是有意并列</span>
                  )}
                  ，全勤奖 <strong>{awards.total - awards.starCount}</strong> 名，
                  已发放 <strong>{awards.delivered}</strong>/{awards.total}。
                </>
              )}
              {awardMsg && <span style={{ marginLeft: '0.5rem', color: 'var(--accent)' }}>{awardMsg}</span>}
            </p>
          )}
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
                    <th>奖项 · 发放</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((b, i) => (
                    <tr key={b.user_id}>
                      <td>{i + 1}</td>
                      <td>
                        <ScrollText text={b.name} />
                        {b.isNew && (
                          <span
                            className="badge warn"
                            style={{ marginLeft: '0.35rem' }}
                            title="本月新加入，次月才参评"
                          >
                            新
                          </span>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>{b.xp}</td>
                      <td className="muted">{b.bonus > 0 ? `+${b.bonus}` : '—'}</td>
                      <td>{b.checkedDays} 天</td>
                      <td>
                        {b.fullAttendance
                          ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>达标</span>
                          : <span className="muted">—</span>}
                      </td>
                      <td>
                        {/* 每行一个奖项：标签 + 两个药丸开关（替代原来"复选框 + 文字标签"两行叠放，
                            后者在窄列里会折行、且两个开关的从属关系看不出来）。 */}
                        <div className="award-cell">
                          {AWARD_ORDER.map((k) => {
                            const rec = awards.byKey.get(awardKey(b.user_id, k));
                            const busy = awardBusy === awardKey(b.user_id, k);
                            return (
                              <div key={k} className="award-row">
                                <span className="award-kind" title={AWARD_HINT[k]}>{AWARD_LABEL[k]}</span>
                                <button
                                  className={`award-pill ${rec ? 'on' : ''}`}
                                  aria-pressed={!!rec}
                                  disabled={busy}
                                  title={rec ? '点击撤销获奖（会删除该条记录）' : '点击记为获奖（学生端立刻可见）'}
                                  onClick={() => void applyAward(b, k, rec ? 'none' : 'awarded')}
                                >
                                  获奖
                                </button>
                                <button
                                  className={`award-pill ${rec?.delivered_at ? 'on' : ''}`}
                                  aria-pressed={!!rec?.delivered_at}
                                  // ⚠ 未获奖时禁用「已发放」：没有记录可标记，
                                  //   而且「先发后录」会让防重复的凭据晚于实物出现。
                                  disabled={busy || !rec}
                                  title={!rec
                                    ? '先标记获奖，才能记录发放'
                                    : rec.delivered_at
                                      ? '点击撤回发放状态（保留获奖记录）'
                                      : '点击记录奖品已发放'}
                                  onClick={() => void applyAward(b, k, rec?.delivered_at ? 'awarded' : 'delivered')}
                                >
                                  已发放
                                </button>
                                {busy && <span className="muted" style={{ fontSize: '0.7rem' }}>…</span>}
                              </div>
                            );
                          })}
                        </div>
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
