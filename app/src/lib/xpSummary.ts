/**
 * 总 XP 的取数与派生（等级 / 今日 / 本月）。
 *
 * 数据源：`get_xp_summary()` ⇒ `{ practice_xp, bonus_xp, total_xp, daily }`。
 * ⚠ 练习 XP 已在服务端按**起算日**过滤（见 `db-migration-xp-start-date.sql`），
 *   所以这里拿到的就是"该学生真正应从 0 开始累计的量"，前端**不要再加时间过滤** ——
 *   两处各过滤一次，将来改起算日时必然漏掉一处。
 *
 * ⚠ 「本月增长」用 `daily` 逐日求和，**不含 `bonus_xp`**（教师奖励没有逐日明细）。
 *   当前 `student_xp_bonus` 为空表，所以两者相等；一旦教师开始签发奖励，
 *   「总 XP」会略大于「各月增长之和」—— 那是预期行为，不是漏算。
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchXpSummary } from './xp';
import { levelOf, type LevelInfo } from './xpLevel';
import { todayKey } from './checkin';

export interface XpView {
  loading: boolean;
  error: string;
  /** 总 XP（练习 + 奖励），等级由它反解 */
  totalXp: number;
  /** 今日已获（练习 XP；「今天」按本地 dateKey，与服务端 day_key 同源） */
  todayXp: number;
  /** 本月已获（练习 XP），用于月度之星的可操作目标 */
  monthXp: number;
  level: LevelInfo;
  reload: () => void;
}

const EMPTY: LevelInfo = { level: 1, into: 0, need: 0, progress: 0 };

export function useXpSummary(enabled = true, userId?: string): XpView {
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [totalXp, setTotalXp] = useState(0);
  const [todayXp, setTodayXp] = useState(0);
  const [monthXp, setMonthXp] = useState(0);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const s = await fetchXpSummary(userId);
        if (!alive) return;
        const today = todayKey();
        const ym = today.slice(0, 7);
        let t = 0;
        let m = 0;
        for (const d of s.daily ?? []) {
          const xp = d.practice_xp ?? 0;
          if (d.day_key === today) t += xp;
          if (d.day_key.slice(0, 7) === ym) m += xp;
        }
        setTotalXp(s.total_xp ?? 0);
        setTodayXp(t);
        setMonthXp(m);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setTotalXp(0);
          setTodayXp(0);
          setMonthXp(0);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, userId, nonce]);

  return {
    loading,
    error,
    totalXp,
    todayXp,
    monthXp,
    level: loading ? EMPTY : levelOf(totalXp),
    reload,
  };
}
