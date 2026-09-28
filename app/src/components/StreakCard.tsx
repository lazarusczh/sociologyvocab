import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import {
  isDayChecked, weeklyStats, canEarnMakeup, missedDaysInWeek, parseKey,
  weekStartKey, addDays, dateKeyOf, MAKEUP_WEEK_QUESTIONS, MAKEUP_WEEK_ACCURACY,
  FULL_ATTENDANCE_DAYS,
} from '../lib/checkin';
import { applyMakeupRpc, MAKEUP_REASON_TEXT, useServerCheckIn } from '../lib/checkinServer';
import { isServerCheckinEnabled } from '../lib/checkinMode';

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
  const canMakeup = useMemo(() => canEarnMakeup(checkin), [checkin]);
  const missed = useMemo(() => missedDaysInWeek(checkin), [checkin]);

  const weekKeys = useMemo(() => {
    const start = parseKey(weekStartKey(new Date()));
    return Array.from({ length: 7 }, (_, i) => dateKeyOf(addDays(start, i)));
  }, []);
  const weeklyCheckedDays = weekKeys.filter((k) => isDayChecked(checkin, k)).length;
  const weeklyMins = Math.floor(weekKeys.reduce((s, k) => s + (checkin.study[k]?.seconds || 0), 0) / 60);

  // 月末全勤提示（《练级与奖励体系方案》§4.5.5：打卡页在月末几天提示「再坚持 X 天即达全勤」）。
  // ⚠ 只在**还有希望**时提示：缺口大于剩余天数就不显示 —— 那时提示等于宣告失败，
  //   而本系统的取向是"门槛只做兜底、别打击人"。
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
          setMsg(`已补签 ${fmtDay(selDay)}`);
          server.reload(); // 重新拉取，让卡片立刻反映新补签
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

      {fullAttendance.show && (
        <p style={{ fontSize: '0.85rem', margin: '0 0 0.5rem', color: 'var(--accent)' }}>
          本月已达标 {fullAttendance.checked} / {FULL_ATTENDANCE_DAYS} 天 —— 再坚持{' '}
          <strong>{fullAttendance.need}</strong> 天即达全勤。
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

      <div style={{ marginTop: '0.7rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
        {missed.length > 0 && canMakeup ? (
          <div className="row">
            <span className="muted" style={{ fontSize: '0.85rem' }}>本周已达标，可补签 1 天：</span>
            <select value={selDay} onChange={(e) => setSelDay(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">选择漏签日期</option>
              {missed.map((k) => <option key={k} value={k}>{fmtDay(k)}</option>)}
            </select>
            <button className="primary" onClick={() => void doApply()} disabled={!selDay || busy}>
              {busy ? '补签中…' : '补签'}
            </button>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
            {missed.length > 0
              ? `补签标准：满 ${MAKEUP_WEEK_QUESTIONS} 题 · 正确率 ≥${Math.round(MAKEUP_WEEK_ACCURACY * 100)}%（当前 ${weekly.questions} 题 · ${Math.round(accuracy * 100)}%）`
              : canMakeup
                ? '本周已达标，但无漏签日可补签。'
                : `补签机会：本周满 ${MAKEUP_WEEK_QUESTIONS} 题 · 正确率 ≥${Math.round(MAKEUP_WEEK_ACCURACY * 100)}% 即获得（每周 1 次）。`}
          </p>
        )}
        {msg && <p style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--accent)' }}>{msg}</p>}
      </div>
    </div>
  );
}
