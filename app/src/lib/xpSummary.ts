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
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchXpSummary, type XpSummary } from './xp';
import { levelOf, type LevelInfo } from './xpLevel';
import { todayKey } from './checkin';
import { flushXpQueue } from './xpQueue';
import { isServerCheckinEnabled } from './checkinMode';

/** 某一天的练习 XP（`daily` 里该日的 `practice_xp`）。
 *  抽出来共用，是因为「今日 XP」现在有两个消费方（等级卡片、结算页的本轮增量）——
 *  各写一份循环，将来 `daily` 口径一变就会分叉。 */
function todayPracticeXp(s: XpSummary): number {
  const today = todayKey();
  let t = 0;
  for (const d of s.daily ?? []) if (d.day_key === today) t += d.practice_xp ?? 0;
  return t;
}

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
        const ym = todayKey().slice(0, 7);
        let m = 0;
        for (const d of s.daily ?? []) {
          if (d.day_key.slice(0, 7) === ym) m += d.practice_xp ?? 0;
        }
        setTotalXp(s.total_xp ?? 0);
        setTodayXp(todayPracticeXp(s));
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

/**
 * 结算页的「本轮获得多少 XP」（《练级与奖励体系方案》§3.3）。
 *
 * 为什么要多花两次往返，而不是把每题的分加起来：
 *   **客户端不知道每题值多少 XP** —— 分值在服务端 `xp_of()` 里，客户端只上报事实
 *   （见 `lib/xp.ts` 顶部）。所以"本轮 +N"只能由**服务端两次读数之差**得出：
 *   起跑线 = 本轮开始前的今日练习 XP，终点 = 结算时的今日练习 XP。
 *
 * ⚠ 结算前**必须先把队列发出去**（`flushXpQueue`）：上报是 15 秒节流的，
 *   刚做完的十几题多半还躺在本地队列里，不 flush 就查不到，会显示成 +0。
 *
 * ⚠ 起跑线必须在**本轮开始之前**取。若在结算时才取（把"此刻的今日 XP"当基线），
 *   差值恒为 0 —— 那是"读得太晚"，与 09-26 那个队列 bug 同一形状的错。
 *   所以 `finished` 落回 false（开了新一轮）时会**重取基线**，否则第二轮会把第一轮的
 *   XP 一起算进去。
 *
 * ⚠ 两种情况下返回 `null`（调用方不显示任何东西，宁可不显示也不显示错的数字）：
 *   ① 判定切换尚未生效（`isServerCheckinEnabled()` 为假）—— 服务端 XP 恒为 0；
 *   ② 起跑线没取到（网络失败）—— 差值无从谈起。
 *
 * ⚠ 口径：只统计**服务端练习 XP**，不含教师奖励（`bonus_xp` 没有逐日明细）。
 *   也不受本地打卡计时影响 —— 两套东西互不相干。
 */
export function useRoundXp(finished: boolean): number | null {
  const enabled = isServerCheckinEnabled();
  const [gain, setGain] = useState<number | null>(null);
  const baseRef = useRef<number | null>(null);
  const baseReady = useRef(false);
  const prevFinished = useRef(false);

  // 起跑线：只在「本轮未完成」时取
  useEffect(() => {
    if (!enabled || finished) return;
    let alive = true;
    baseReady.current = false;
    void (async () => {
      try {
        const s = await fetchXpSummary();
        if (alive) baseRef.current = todayPracticeXp(s);
      } catch {
        // 取不到 ⇒ base 保持 null ⇒ 本轮结算不显示
      } finally {
        if (alive) baseReady.current = true;
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, finished]);

  useEffect(() => {
    if (!enabled) return;
    if (!finished) {
      prevFinished.current = false;
      return;
    }
    if (prevFinished.current) return; // 只在 false→true 的边沿结算一次
    prevFinished.current = true;
    void (async () => {
      // 起跑线通常早就回来了；本轮极短时才需要等一下（最多 2 秒）。
      // 拿不到就放弃显示 —— 用"本轮之前的今日 XP"当基线是唯一正确的做法。
      for (let i = 0; i < 40 && !baseReady.current; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const base = baseRef.current;
      if (base === null) return;
      try {
        await flushXpQueue();
        const s = await fetchXpSummary();
        setGain(Math.max(0, todayPracticeXp(s) - base));
      } catch {
        // 查不到就不显示
      }
    })();
  }, [finished, enabled]);

  return gain;
}
