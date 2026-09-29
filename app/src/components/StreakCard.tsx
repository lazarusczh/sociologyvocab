import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import {
  isDayChecked, weeklyStats, canEarnMakeup, missedDaysInWeek, missedDaysWithin, parseKey,
  weekStartKey, addDays, dateKeyOf, MAKEUP_WEEK_QUESTIONS, MAKEUP_WEEK_ACCURACY,
  FULL_ATTENDANCE_DAYS,
} from '../lib/checkin';
import { applyMakeupRpc, MAKEUP_REASON_TEXT, useServerCheckIn } from '../lib/checkinServer';
import { isServerCheckinEnabled } from '../lib/checkinMode';
import { useCardBalance } from '../lib/cards';

/** 补签可回溯的天数（§4.3：可补最近 30 天内的漏签日）。
 *
 *  ⚠ **必须与服务端 `apply_makeup()` 的窗口一致**（`p_day_key < v_today - 30` 即拒）。
 *    这里只用来**列候选**：列多了也没关系（服务端会拒），但列少了学生就看不到可选的日子。 */
const MAKEUP_WINDOW_DAYS = 30;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function fmtDay(key: string): string {
  const d = parseKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

export default function StreakCard() {
  const { checkin: localCheckin, applyMakeup, authUser } = useStore();
  // 切换时刻前（或强制关闭时）**不发请求**；到点后学生下次打开页面即自动走服务端
  const usingServer = isServerCheckinEnabled();
  const server = useServerCheckIn(undefined, undefined, undefined, usingServer);
  // 卡余额只在服务端口径下有意义（补签卡是服务端的扣费对象；本地那套是「当周机会」）。
  // ⚠ `get_card_balance()` 未登录会抛异常 ⇒ 游客必须关掉，否则每次开页面都多一条失败请求。
  const cards = useCardBalance(usingServer && !!authUser);
  const [selDay, setSelDay] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // ---- 口径选择（第④步：本地 → 服务端）----
  // ⚠ 服务端数据是**异步**来的，而打卡卡是首屏就渲染的。三种情况都要处理：
  //   ① 已拿到服务端数据 ⇒ 用服务端（权威口径）
  //   ② 尚未拿到（加载中）⇒ 暂用本地，避免整卡闪成「0 天」；
  //      加载只需一次 RPC（几百毫秒），且服务端口径通常**不高于**本地，
  //      所以过渡方向是「从严」，不会先给学生一个虚高的数字。
  //   ③ 加载失败 ⇒ 退回本地**并明确提示** —— 直接显示 0 天会让学生以为记录丢了，
  //      那是比口径不准更糟的体验。
  const serverReady = usingServer && !!server.checkin;
  const checkin = serverReady ? server.checkin! : localCheckin;
  const showLocalFallback = usingServer && !server.checkin;

  const weekly = useMemo(() => weeklyStats(checkin), [checkin]);
  const accuracy = weekly.questions > 0 ? weekly.correct / weekly.questions : 0;
  // ⚠ 这是**本地下线路径**的资格判断（「本周满 100 题 + 正确率 ≥80% ⇒ 本周 1 次」）。
  //   服务端口径下**不用它** —— 那里的资格是「有没有补签卡」，只有 `apply_makeup()` 说了算。
  const canMakeup = useMemo(() => canEarnMakeup(checkin), [checkin]);

  // 候选漏签日。切换后放开到**最近 30 天**（§4.3），切换前仍是「本周」。
  const missed = useMemo(
    () => (usingServer ? missedDaysWithin(checkin, MAKEUP_WINDOW_DAYS) : missedDaysInWeek(checkin)),
    [checkin, usingServer],
  );

  // 服务端口径下「能不能补」取决于**卡**，本地路径取决于**本周机会**。
  const cardCount = cards.balance.makeup;
  const canMakeupNow = usingServer ? cardCount > 0 : canMakeup;
  // ⚠ 两样都就绪才给结论：打卡数据与卡余额**各自是异步的**，任一还没到，
  //   `cardCount` 都是占位的 0 ⇒ 会显示成「补签卡用完了」，而学生其实有卡。
  //   宁可先不显示控制项（那只是慢几百毫秒），也不要给一个错的结论。
  const makeupReady = !usingServer || (serverReady && !cards.loading && !cards.error);

  // 补签区的提示文字。四种组合（服务端/本地 × 有候选/无候选）要说的话不同 ——
  // 服务端口径讲的是**卡**，本地下线路径讲的是**当周机会**，混用会让学生以为规则没变。
  const makeupHint = usingServer
    ? missed.length > 0
      ? `有漏签日，但补签卡用完了 —— 每周练习满 ${MAKEUP_WEEK_QUESTIONS} 题且正确率 ≥${Math.round(MAKEUP_WEEK_ACCURACY * 100)}% 得 1 张，等级里程碑也会发。卡不过期、可累积。`
      : `最近 ${MAKEUP_WINDOW_DAYS} 天没有漏签日，没有需要补的地方。`
    : missed.length > 0
      ? `补签标准：满 ${MAKEUP_WEEK_QUESTIONS} 题 · 正确率 ≥${Math.round(MAKEUP_WEEK_ACCURACY * 100)}%（当前 ${weekly.questions} 题 · ${Math.round(accuracy * 100)}%）`
      : canMakeup
        ? '本周已达标，但无漏签日可补签。'
        : `补签机会：本周满 ${MAKEUP_WEEK_QUESTIONS} 题 · 正确率 ≥${Math.round(MAKEUP_WEEK_ACCURACY * 100)}% 即获得（每周 1 次）。`;

  const weekKeys = useMemo(() => {
    const start = parseKey(weekStartKey(new Date()));
    return Array.from({ length: 7 }, (_, i) => dateKeyOf(addDays(start, i)));
  }, []);
  const weeklyCheckedDays = weekKeys.filter((k) => isDayChecked(checkin, k)).length;
  const weeklyMins = Math.floor(weekKeys.reduce((s, k) => s + (checkin.study[k]?.seconds || 0), 0) / 60);

  // 本月全勤进度（《练级与奖励体系方案》§4.5.5）。
  // ⚠ `show` 只是**「要不要说那句鼓励」**的开关，不再是「整块要不要显示」：
  //   已达标天数本身**常显**（它是本月的可操作目标），而「再坚持 N 天即达全勤」
  //   只在缺口 ≤ 剩余天数时才说 —— 缺口更大时说出口等于宣告失败。
  // ⚠ 与教师端榜单的 `fullAttendance` 必须是同一个口径：都走 `isDayChecked` + `FULL_ATTENDANCE_DAYS`
  //   （阈值收敛在 `lib/checkin.ts`，不在这两个组件里各写一份）。
  const fullAttendance = useMemo(() => {
    const now = new Date();
    const ym = dateKeyOf(now).slice(0, 7);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    // 「剩余天数」含今天 —— 今天还没结束，仍有机会达标
    const daysLeft = daysInMonth - now.getDate() + 1;
    const checked = new Set<string>();
    for (const k of Object.keys(checkin.study)) if (k.startsWith(ym) && isDayChecked(checkin, k)) checked.add(k);
    for (const k of Object.keys(checkin.makeup)) if (k.startsWith(ym) && checkin.makeup[k]) checked.add(k);
    const need = FULL_ATTENDANCE_DAYS - checked.size;
    return {
      show: daysLeft <= 5 && need > 0 && need <= daysLeft,
      need,
      checked: checked.size,
      daysLeft,
    };
  }, [checkin]);

  const doApply = async () => {
    if (!selDay) return;

    // 走服务端：资格判定与落库都在服务端（前端只传日子、翻译失败原因）
    if (serverReady) {
      setBusy(true);
      try {
        const r = await applyMakeupRpc(selDay);
        if (r.ok) {
          setMsg(`已补签 ${fmtDay(selDay)}，剩余补签卡 ${r.balance ?? 0} 张`);
          server.reload(); // 重新拉取，让卡片立刻反映新补签
          cards.reload();  // 余额也要跟着减 1（服务端扣了卡，前端不重取就会显示旧张数）
        } else {
          setMsg(`补签失败：${MAKEUP_REASON_TEXT[r.reason ?? ''] ?? r.reason ?? '未知原因'}`);
        }
      } catch (e) {
        setMsg(`补签失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
        setSelDay('');
      }
      return;
    }

    // 回退路径：本地补签（仅当开关关闭或服务端不可用时走到这）
    const ok = applyMakeup(selDay);
    setMsg(ok ? `已补签 ${fmtDay(selDay)}` : '补签失败（不满足条件）');
    setSelDay('');
  };

  return (
    <div className="card" style={{ marginBottom: '0.8rem' }}>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>本周目标</h2>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: '0.85rem' }}>{weeklyCheckedDays}/7 天打卡</span>
      </div>

      {/* 本月全勤进度（§4.5.5：与「本月 XP 增长」并列为本月的可操作目标）。
          ⚠ 刻意拆成两层，为的是**不打击后进**：
            · **进度**（已达标 X / 28 天）**常显** —— 它是事实，也是"可操作目标"的锚点；
            · **「再坚持 N 天即达全勤」只在还有可能时**才说 —— 缺口大于剩余天数时说出来
              等于宣告失败，而本系统的取向是「门槛只做兜底、别打击人」。
          ⚠ 只给登录用户看：游客的练习不计入打卡（见上方提示），显示 0/28 只是噪音。 */}
      {authUser && (
        <p className="muted" style={{ fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
          本月已达标 <strong>{fullAttendance.checked}</strong> / {FULL_ATTENDANCE_DAYS} 天
          {fullAttendance.checked >= FULL_ATTENDANCE_DAYS ? (
            <>，<strong style={{ color: 'var(--success)' }}>已达全勤</strong></>
          ) : fullAttendance.show ? (
            <>，再坚持 <strong style={{ color: 'var(--accent)' }}>{fullAttendance.need}</strong> 天即达全勤</>
          ) : null}
        </p>
      )}

      {!authUser && (
        <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 0.5rem' }}>
          当前是离线游客模式：<strong>练习不计入打卡与等级</strong>。登录后练习才会被记录。
        </p>
      )}

      {showLocalFallback && (
        <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 0.5rem' }}>
          {server.error ? `暂时无法核对云端记录，以下为本机数据（${server.error}）` : '正在核对云端记录…'}
        </p>
      )}

      <div className="grid cols-3">
        <div className="stat"><span className="num">{weeklyMins}</span><span className="label">本周学习（分钟）</span></div>
        <div className="stat"><span className="num">{weekly.questions}</span><span className="label">本周题数</span></div>
        <div className="stat"><span className="num">{Math.round(accuracy * 100)}%</span><span className="label">本周正确率</span></div>
      </div>

      {/* 卡余额：只在服务端口径下显示（本地那套是「当周机会」，没有卡这个概念）。
          ⚠ 读不到时不显示 0 张 —— 那会把"读失败"伪装成"你没有卡"，
            而学生据此会以为自己的努力没被承认；这里改成一句明确的提示（见下方补签区）。 */}
      {usingServer && !cards.loading && !cards.error && (
        <div className="row tight" style={{ marginTop: '0.6rem', fontSize: '0.85rem' }}>
          <span className={cardCount > 0 ? 'badge success' : 'badge'}>补签卡 {cardCount} 张</span>
          <span className="badge">加分卡 {cards.balance.bonus} 张</span>
        </div>
      )}

      <div style={{ marginTop: '0.7rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
        {!makeupReady ? (
          <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
            {cards.error
              ? `卡余额暂时读不到（${cards.error}），稍后可重试补签。`
              : '正在核对云端记录，稍后可补签。'}
          </p>
        ) : missed.length > 0 && canMakeupNow ? (
          <div className="row">
            <span className="muted" style={{ fontSize: '0.85rem' }}>
              {usingServer ? `可补最近 ${MAKEUP_WINDOW_DAYS} 天内的漏签日：` : '本周已达标，可补签 1 天：'}
            </span>
            <select value={selDay} onChange={(e) => setSelDay(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">选择漏签日期</option>
              {missed.map((k) => <option key={k} value={k}>{fmtDay(k)}</option>)}
            </select>
            <button className="primary" onClick={() => void doApply()} disabled={!selDay || busy}>
              {busy ? '补签中…' : '补签'}
            </button>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>{makeupHint}</p>
        )}
        {msg && <p style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--accent)' }}>{msg}</p>}
      </div>
    </div>
  );
}
