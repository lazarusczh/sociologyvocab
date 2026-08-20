import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import {
  todayKey, isDayChecked, computeStreak, weeklyStats, canEarnMakeup, missedDaysInWeek, parseKey,
  CHECKIN_DAY_GOAL_SECONDS, CHECKIN_DAY_GOAL_QUESTIONS, MAKEUP_WEEK_QUESTIONS,
} from '../lib/checkin';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const GOAL_MINUTES = Math.round(CHECKIN_DAY_GOAL_SECONDS / 60);

function fmtDay(key: string): string {
  const d = parseKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

export default function StreakCard() {
  const { checkin, applyMakeup } = useStore();
  const [selDay, setSelDay] = useState('');
  const [msg, setMsg] = useState('');

  const streak = useMemo(() => computeStreak(checkin), [checkin]);
  const today = todayKey();
  const dayStats = checkin.study[today] || { seconds: 0, questions: 0, correct: 0 };
  const checked = isDayChecked(checkin, today);
  const mins = Math.floor(dayStats.seconds / 60);
  const weekly = useMemo(() => weeklyStats(checkin), [checkin]);
  const accuracy = weekly.questions > 0 ? weekly.correct / weekly.questions : 0;
  const canMakeup = useMemo(() => canEarnMakeup(checkin), [checkin]);
  const missed = useMemo(() => missedDaysInWeek(checkin), [checkin]);

  const needMins = Math.max(0, GOAL_MINUTES - mins);
  const needQ = Math.max(0, CHECKIN_DAY_GOAL_QUESTIONS - dayStats.questions);

  const doApply = () => {
    if (!selDay) return;
    const ok = applyMakeup(selDay);
    setMsg(ok ? `已补签 ${fmtDay(selDay)}` : '补签失败（不满足条件）');
    setSelDay('');
  };

  return (
    <div className="card" style={{ marginBottom: '0.8rem' }}>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>学习打卡</h2>
        <span className="spacer" />
        {checked && <span className="badge success">今日已打卡</span>}
      </div>

      <div className="grid cols-3">
        <div className="stat"><span className="num">🔥 {streak}</span><span className="label">连续天数</span></div>
        <div className="stat"><span className="num">{checkin.bestStreak}</span><span className="label">最长纪录（天）</span></div>
        <div className="stat"><span className="num">{mins}</span><span className="label">今日已学（分钟）</span></div>
      </div>

      <div className="row" style={{ marginTop: '0.6rem' }}>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          今日已答 {dayStats.questions} 题
          {!checked && `（还差 ${needMins} 分钟、${needQ} 题完成打卡）`}
          {checked && '，完成今日打卡'}
        </span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          本周 {weekly.questions}/{MAKEUP_WEEK_QUESTIONS} 题 · 正确率 {Math.round(accuracy * 100)}%
        </span>
      </div>

      <div style={{ marginTop: '0.6rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
        {missed.length > 0 ? (
          canMakeup ? (
            <div className="row">
              <span className="muted" style={{ fontSize: '0.85rem' }}>本周达标，可用 1 次补签：</span>
              <select value={selDay} onChange={(e) => setSelDay(e.target.value)} style={{ maxWidth: 220 }}>
                <option value="">选择漏签日期</option>
                {missed.map((k) => <option key={k} value={k}>{fmtDay(k)}</option>)}
              </select>
              <button className="primary" onClick={doApply} disabled={!selDay}>补签</button>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
              本周有 {missed.length} 个漏签日。补签条件：本周练习满 {MAKEUP_WEEK_QUESTIONS} 题且正确率 ≥80%
              （当前 {weekly.questions} 题 / {Math.round(accuracy * 100)}%）。
            </p>
          )
        ) : (
          <p className="muted" style={{ fontSize: '0.85rem', margin: 0 }}>
            {canMakeup
              ? '本周无漏签日，暂无需补签。'
              : '坚持每天练习即可累积连续天数；本周达标后可获得补签机会。'}
          </p>
        )}
        {msg && <p style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--accent)' }}>{msg}</p>}
      </div>
    </div>
  );
}