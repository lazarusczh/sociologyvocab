import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import {
  isDayChecked, weeklyStats, canEarnMakeup, missedDaysInWeek, parseKey,
  weekStartKey, addDays, dateKeyOf, MAKEUP_WEEK_QUESTIONS,
} from '../lib/checkin';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function fmtDay(key: string): string {
  const d = parseKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

export default function StreakCard() {
  const { checkin, applyMakeup } = useStore();
  const [selDay, setSelDay] = useState('');
  const [msg, setMsg] = useState('');

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

  const doApply = () => {
    if (!selDay) return;
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
            <button className="primary" onClick={doApply} disabled={!selDay}>补签</button>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
            {missed.length > 0
              ? `补签标准：满 ${MAKEUP_WEEK_QUESTIONS} 题 · 正确率 ≥80%（当前 ${weekly.questions} 题 · ${Math.round(accuracy * 100)}%）`
              : canMakeup
                ? '本周已达标，但无漏签日可补签。'
                : `补签机会：本周满 ${MAKEUP_WEEK_QUESTIONS} 题 · 正确率 ≥80% 即获得（每周 1 次）。`}
          </p>
        )}
        {msg && <p style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--accent)' }}>{msg}</p>}
      </div>
    </div>
  );
}