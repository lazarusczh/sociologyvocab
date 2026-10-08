/**
 * 服务端打卡状态（第④步：打卡判定从本地切到服务端）
 *
 * 背景：打卡的权威口径原本在本地 `student_data.checkin`（可被改、且教师看到的是快照），
 *   而月度全勤奖是**实物出口**。第④步把判定切到服务端：
 *
 *     服务端每日达标 = `checkin_baselines`（历史/补齐基线）∪ `xp_events`（上线后事件）
 *                      ∪ `checkin_makeups`（补签），由 `get_daily_study()` 一次返回。
 *
 * ⚠ 本模块**只负责取数与装形**，达标门槛**必须复用 `lib/checkin.ts` 的 `isDayChecked`**
 *   （装成同一 `CheckInState` 形状再调用）。理由：两侧若各写一套门槛，
 *   出现差异时分不清是「数据不同」还是「门槛写不同」—— 那正是双跑对照要排除的干扰。
 *
 * ⚠ 单位：本地 `seconds` 是**秒**，服务端 `ms` 是**毫秒** ⇒ 装形时除以 1000（取整）。
 *
 * ⚠ 日期范围：**不要只取最近若干天**。`computeStreak()` 往回逐日数，缺了更早的日子
 *   会让连续天数断掉；`bestStreak` 也需要全序列。`get_daily_study()` 不传 from/to 即全量，
 *   当前量级（每人几十天）完全够用。
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { fetchDailyStudy, type DailyStudy } from './xp';
import { addDays, dateKeyOf, isDayChecked, parseKey, todayKey } from './checkin';
import type { CheckInState, DayStudy } from './types';

/** 空状态（与服务端无数据时一致；`earnedMakeupWeeks` 由补签记录推得，见下） */
export function emptyServerCheckIn(): CheckInState {
  return { study: {}, makeup: {}, earnedMakeupWeeks: [], bestStreak: 0 };
}

/**
 * 逐日聚合 → `CheckInState` 形状。
 *
 * `earnedMakeupWeeks` 填的是**已补签的周**（取自服务端 `makeup` 标记所在周的周一）。
 * ⚠ 它与本地那个「已领过补签机会的周」**语义不完全相同**（本地是"领过机会"，
 *   这里只能观察到"用掉了"）。第④步之后补签的资格判断改由服务端 `apply_makeup()` 负责
 *   （它用 `unique(user_id, week_start)` 判"本周是否已补过"），前端**不再自行判定资格**，
 *   所以此处填"已用周"即可满足展示需要。
 */
export function serverToCheckInState(days: DailyStudy[]): CheckInState {
  const study: Record<string, DayStudy> = {};
  const makeup: Record<string, true> = {};
  const earnedMakeupWeeks = new Set<string>();

  for (const d of days) {
    study[d.day_key] = {
      // ⚠⚠ **毫秒 → 秒必须用 `floor`，不能用 `round`**（2026-10-08 修）：
      //   服务端的达标判据是 `ms >= 600000`，而前端在这里转成秒后用的是 `seconds >= 600`。
      //   用 `round` 时，`ms = 599500~599999` 会被四舍五入成 **600** ⇒
      //   **前端拿着服务端自己的数据都会判「达标」，而服务端判「不达标」**（0.5 秒的窗口）。
      //   `floor` 与之严格等价：`floor(ms/1000) >= 600` ⟺ `ms >= 600000`。
      //   代价只是显示上少不到 1 秒，方向与服务端一致。
      seconds: Math.floor((d.ms ?? 0) / 1000),
      questions: d.questions ?? 0,
      correct: d.correct ?? 0,
    };
    if (d.makeup) {
      makeup[d.day_key] = true;
      earnedMakeupWeeks.add(dateKeyOf(parseKey(weekStartOf(d.day_key))));
    }
  }

  const state: CheckInState = {
    study,
    makeup,
    earnedMakeupWeeks: [...earnedMakeupWeeks],
    bestStreak: 0,
  };
  state.bestStreak = bestStreakOf(state);
  return state;
}

/** 某日所在周的周一（dateKey）。与服务端 `date_trunc('week', …)` 同义（周一为一周之始）。 */
function weekStartOf(dayKey: string): string {
  const d = parseKey(dayKey);
  const day = d.getDay(); // 0 = 周日
  const diff = day === 0 ? -6 : 1 - day;
  return dateKeyOf(addDays(d, diff));
}

/**
 * 历史最长连续天数。
 *
 * ⚠ 服务端 `get_daily_study()` **不返回** `bestStreak` —— 它只给逐日聚合。
 *   本地那份是每记录一次就 `Math.max` 累加出来的（`recordFormalAnswer`），
 *   切到服务端后没有写入时机，只能**从日序列现算**（与「总量现算、永不落盘」的既有哲学一致）。
 */
export function bestStreakOf(state: CheckInState): number {
  const checked = new Set<string>();
  for (const k of Object.keys(state.study)) {
    if (isDayChecked(state, k)) checked.add(k);
  }
  for (const k of Object.keys(state.makeup)) {
    if (state.makeup[k]) checked.add(k);
  }

  const sorted = [...checked].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of sorted) {
    run = prev && dateKeyOf(addDays(parseKey(prev), 1)) === day ? run + 1 : 1;
    if (run > best) best = run;
    prev = day;
  }
  return best;
}

/** 取服务端打卡状态（省略 userId 即查自己；教师/开发者可查他人，服务端会校验归属） */
export async function fetchServerCheckIn(
  userId?: string,
  from?: string,
  to?: string,
): Promise<CheckInState> {
  const days = await fetchDailyStudy(userId, from, to);
  return serverToCheckInState(days);
}

// ---------------------------------------------------------------------------
// 补签（第④步一并服务端化）
//
// 为什么必须一起切：补签直接改变「达标天数」，而月度全勤奖是**实物出口**。
//   本地 `makeup` 只是一个 `{ dayKey: true }` 映射，插一条就多一天达标 ——
//   比伪造 `study` 记录容易得多。若只切练习判定、不切补签，全勤奖仍有一条
//   客户端可篡改的路径。
// ---------------------------------------------------------------------------

/** `apply_makeup()` 的返回（**v2：补签卡模型**）。
 *  `ok=true` 时带 `day_key` 与**扣卡后的余额**；否则带 `reason`。 */
export interface MakeupResult {
  ok: boolean;
  /** 失败原因，共 5 种（见下方 `MAKEUP_REASON_TEXT`） */
  reason?: string;
  /** 成功时：被补的那天 */
  day_key?: string;
  /** 成功时：扣卡后的补签卡余额；`no_cards` 时为 0 */
  balance?: number;
  /** `too_old` 时的窗口天数（30） */
  limit_days?: number;
}

/**
 * 失败原因 → 给学生看的说法。
 * 与 `db-migration-makeup-v2.sql` 里 `apply_makeup()` 的 return 一一对应。
 *
 * ⚠ 三条旧原因（`not_this_week` / `week_questions_low` / `week_accuracy_low` /
 *   `week_already_used`）**已在 v2 里消失** —— 规则从「当周赚当周用」改成「补签卡」后，
 *   不再有「只能补本周」「本周练习量够不够」这些前置条件（§4.3）。
 *   留着它们不会报错，但会在界面里显示出一条永远不可能出现的提示。
 */
export const MAKEUP_REASON_TEXT: Record<string, string> = {
  not_past_day: '只能补今天以前的日期',
  too_old: '只能补最近 30 天内的漏签日',
  already_made_up: '该日已经补签过了',
  already_checked: '该日已达标，不用补签',
  no_cards: '没有补签卡了',
};

/**
 * 调用服务端补签。
 *
 * ⚠ 服务端的四条校验（早于今天 / 在最近 30 天内 / 该天未达标 / **有卡**）**前端不重复实现** ——
 *   前端只负责把日子传上去、把 `reason` 翻译成人话。
 *   重复实现会让两处口径分叉，而补签的判定本来就该只有一份。
 */
export async function applyMakeupRpc(dayKey: string): Promise<MakeupResult> {
  const { data, error } = await supabase.rpc('apply_makeup', { p_day_key: dayKey });
  if (error) throw new Error(error.message || 'apply_makeup failed');
  return (data ?? { ok: false, reason: 'unknown' }) as MakeupResult;
}

/**
 * 教师端批量取数：全班每人一份服务端打卡状态。
 *
 * 服务端 `get_daily_study_all(p_from, p_to)` 是 **staff-only**，返回
 * `[{ user_id, days: [{ day_key, questions, ms, correct, makeup, correct_full }] }]`。
 *
 * ⚠ 人员口径由服务端决定（以 `student_data` 为准并排除 `teacher`/`developer`），
 *   与教师后台「打卡核验」原本的口径一致 —— 所以**不要**在前端再筛一遍名单，
 *   那会引入第二份口径。
 */
export async function fetchAllServerCheckIn(
  from?: string,
  to?: string,
): Promise<Map<string, CheckInState>> {
  const { data, error } = await supabase.rpc('get_daily_study_all', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) throw new Error(error.message || 'get_daily_study_all failed');

  const rows = (data ?? []) as { user_id: string; days: DailyStudy[] }[];
  const out = new Map<string, CheckInState>();
  for (const r of rows) out.set(r.user_id, serverToCheckInState(r.days ?? []));
  return out;
}

export interface ServerCheckInResult {
  /** 服务端口径的打卡状态；尚未加载完成为 null */
  checkin: CheckInState | null;
  loading: boolean;
  error: string;
  reload: () => void;
}

/**
 * 学生端/教师端读服务端打卡状态的 hook。
 *
 * `enabled = false` 时**完全不发请求**（切换尚未生效时不该为它付网络开销）。
 *
 * ⚠ 与本地 `useStore().checkin` 的关键差别：**这是异步的**（一次网络往返）。
 *   所以调用方必须处理 `checkin === null`（加载中）—— 不要用「null 就当无记录」，
 *   那会在加载完成的瞬间让连签天数闪一下 0。
 */
export function useServerCheckIn(
  userId?: string,
  from?: string,
  to?: string,
  enabled = true,
): ServerCheckInResult {
  const [checkin, setCheckin] = useState<CheckInState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setCheckin(null);
      setLoading(false);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const next = await fetchServerCheckIn(userId, from, to);
        if (alive) setCheckin(next);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setCheckin(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId, from, to, nonce, enabled]);

  return { checkin, loading, error, reload };
}

/**
 * 今日是否已在服务端达标。
 *
 * ⚠ 用于「打卡成功」弹窗：它必须与打卡页**同一口径**，否则会出现
 *   「弹窗说打卡成功、打卡页却显示未达标」这种自相矛盾。
 *   弹窗时机在练习过程中（数据可能刚上报、还没 flush 到服务端），
 *   所以调用方应传入 `reload()` 拿到的最新值，或在 flush 之后再判。
 */
export function isTodayCheckedIn(checkin: CheckInState | null): boolean {
  if (!checkin) return false;
  return isDayChecked(checkin, todayKey());
}
