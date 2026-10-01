/**
 * 月度获奖记录（《练级与奖励体系方案》§4.5.4「结算与核验」/ §4.5.5 展示）。
 *
 * 数据源：`award_records`（`db-migration-awards.sql`），写入走 staff-only 的
 * `set_award_record()` RPC。
 *
 * ---------------------------------------------------------------------------
 * ⚠ 为什么要**两个**时间戳，而不是一个「已发放」
 *
 * §4.5.4 的三步是「看榜单 → 核验 → 勾『已发放』」，其中**核验**与**把奖品交到学生手上**
 * 是两个时刻，中间常常隔好几天（名单月初定、奖品课间发）。所以：
 *   · `awarded_at`   —— 教师核验后落库 ⇒ **学生端「是否获奖」看它**
 *   · `delivered_at` —— 勾「已发放」⇒ 用于防重复发放
 *
 * 若只有「已发放」，学生在奖品到手之前会看到「未获奖」—— 而他其实已经赢了。
 * 「我明明拿了第一，系统却说我没获奖」是最伤信任的一种显示。
 *
 * ---------------------------------------------------------------------------
 * ⚠ 读用**直表 select**（RLS 兜底），写用 RPC
 *
 * `award_records` 的两条 select 策略（`read_own` / `read_staff`）已经覆盖了两种读法：
 * 学生读到自己的行、教师读到全班。**写**则没有策略、且 `insert/update/delete`
 * 已从 `authenticated` 收回 ⇒ 只能经 `set_award_record()`（它自己做 staff 校验）。
 *
 * ⚠ `month_key` 是 `'YYYY-MM'` 文本，与 `get_xp_summary_all().joined_month` 同形
 *   ⇒ 与榜单行拼接时不需要任何日期转换（转换就有写错一个月的机会）。
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export type AwardKind = 'star' | 'full_attendance';

/** 奖项名（§4.5.1）。 */
export const AWARD_LABEL: Record<AwardKind, string> = {
  star: '月度之星',
  full_attendance: '全勤奖',
};

/** 奖项说明（教师端提示用）。 */
export const AWARD_HINT: Record<AwardKind, string> = {
  star: '本月 XP 增长最高（1 名；并列则都发）',
  full_attendance: '本月打卡 ≥28 天（不限名额）',
};

export interface AwardRecord {
  month_key: string;
  user_id: string;
  award: AwardKind;
  awarded_at: string;
  /** `null` = 名单已定、实物尚未交到学生手上 */
  delivered_at: string | null;
}

/** `set_award_record()` 的三种意图。 */
export type AwardState = 'awarded' | 'delivered' | 'none';

export interface AwardWriteResult {
  ok: boolean;
  state: AwardState;
  month_key: string;
  award: AwardKind;
  awarded_at?: string;
  delivered_at?: string | null;
}

const COLUMNS = 'month_key,user_id,award,awarded_at,delivered_at';

// ---------------------------------------------------------------------------
// 读：某月的全班记录（教师端）
// ---------------------------------------------------------------------------

export async function fetchAwardsForMonth(monthKey: string): Promise<AwardRecord[]> {
  const { data, error } = await supabase
    .from('award_records')
    .select(COLUMNS)
    .eq('month_key', monthKey);
  if (error) throw new Error(error.message || 'award_records read failed');
  return (data ?? []) as AwardRecord[];
}

export interface MonthAwardsView {
  /** 该月的记录，按「(user_id, award)」索引，方便逐行查 */
  byKey: Map<string, AwardRecord>;
  /** 该月已列的月度之星人数（>1 时界面应提示——§4.5.1 允许并列，但要教师知道） */
  starCount: number;
  /** 该月已发放条数 / 总条数 */
  delivered: number;
  total: number;
  loading: boolean;
  error: string;
  reload: () => void;
}

/** 组合键：一个学生 + 一个奖项。 */
export const awardKey = (userId: string, award: AwardKind) => `${userId}:${award}`;

/**
 * 读某月获奖记录（教师端）。
 *
 * ⚠ `enabled=false` 时完全不发请求：非 staff（RLS 会返回空集，那不算错但要白花一次往返）、
 *   未登录、以及**非月度口径**（累计口径没有「本月获奖」这个概念）。
 */
export function useMonthAwards(monthKey: string | null, enabled = true): MonthAwardsView {
  const [rows, setRows] = useState<AwardRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled || !monthKey) {
      setRows([]);
      setLoading(false);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const r = await fetchAwardsForMonth(monthKey);
        if (alive) setRows(r);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setRows([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, monthKey, nonce]);

  const byKey = new Map<string, AwardRecord>();
  let starCount = 0;
  let delivered = 0;
  for (const r of rows) {
    byKey.set(awardKey(r.user_id, r.award), r);
    if (r.award === 'star') starCount += 1;
    if (r.delivered_at) delivered += 1;
  }

  return { byKey, starCount, delivered, total: rows.length, loading, error, reload };
}

// ---------------------------------------------------------------------------
// 写：教师端
// ---------------------------------------------------------------------------

/**
 * 记录 / 撤销月度获奖（§4.5.4）。
 *
 * ⚠ 失败会**抛异常**（服务端 `raise exception`）而不是返回 `ok:false` —— 与加分卡的
 *   `use_bonus_card()` 不同：那里失败是**业务性**的（没卡了），这里失败都是
 *   「参数错了 / 权限不对 / 目标不对」，属于调用方写错了，应当显式暴露。
 *
 * ⚠ `'awarded'` 会**清掉 `delivered_at`** ⇒ 它就是「撤销已发放」。
 *   所以界面上取消勾选「已发放」调的是 `'awarded'`，而不是再发明一个动作。
 */
export async function setAwardRecord(
  monthKey: string,
  userId: string,
  award: AwardKind,
  state: AwardState,
): Promise<AwardWriteResult> {
  const { data, error } = await supabase.rpc('set_award_record', {
    p_month_key: monthKey,
    p_user_id: userId,
    p_award: award,
    p_state: state,
  });
  if (error) throw new Error(error.message || 'set_award_record failed');
  return (data ?? { ok: false, state, month_key: monthKey, award }) as AwardWriteResult;
}

// ---------------------------------------------------------------------------
// 读：学生端（自己的记录）
// ---------------------------------------------------------------------------

/** 学生端最多看几条（每月最多 2 条，3 个月够用；避免无限拉取）。 */
const MY_AWARDS_LIMIT = 6;

export interface MyAwardsView {
  /** 最近几个月自己的获奖记录，按 month_key 倒序 */
  rows: AwardRecord[];
  loading: boolean;
  /** 非空表示**没读到**（此时 `rows` 为空，不能当作「没获奖」展示） */
  error: string;
  reload: () => void;
}

/**
 * 读自己的获奖记录（RLS `read_own` 兜底，不需要 RPC）。
 *
 * ⚠ 调用方必须区分「读到了、没有记录」与「没读到」：都显示成「暂无获奖」会把
 *   一次读取失败伪装成「你没获奖」—— 而学生据此会以为自己白练了一个月。
 *   （与 `useCardBalance` 的处理一致。）
 *
 * ⚠ 未登录会因 RLS 返回**空集**（不报错）⇒ 游客必须 `enabled=false`，
 *   否则会显示成「你没获奖」而不是「请登录」。
 */
export function useMyAwards(enabled = true): MyAwardsView {
  const [rows, setRows] = useState<AwardRecord[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setRows([]);
      setLoading(false);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const { data, error: err } = await supabase
          .from('award_records')
          .select(COLUMNS)
          .order('month_key', { ascending: false })
          .limit(MY_AWARDS_LIMIT);
        if (err) throw new Error(err.message || 'award_records read failed');
        if (alive) setRows((data ?? []) as AwardRecord[]);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setRows([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);

  return { rows, loading, error, reload };
}

/** `'2026-09'` → `'9 月'`（只用于展示，不做任何日期运算）。 */
export function monthLabel(monthKey: string): string {
  const m = monthKey.split('-')[1] ?? '';
  return `${Number(m)} 月`;
}
