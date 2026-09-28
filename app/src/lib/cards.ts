/**
 * 卡余额（补签卡 / 加分卡）的取数。
 *
 * 《练级与奖励体系方案》§4.2 / §4.3：两种卡**共用一个余额池的概念、但分别计数** ——
 *   补签卡用于补漏签日（§4.3），加分卡用于作业再次加分（§4.2.1）。
 *
 * 数据源：`get_card_balance()` ⇒ `{ makeup, bonus }`（`db-migration-cards.sql`）。
 *
 * ⚠ **余额在服务端是「现算」的，不是存出来的**：
 *   余额 = `card_grants` 条数 − 使用条数（补签卡的使用由 `checkin_makeups` 承担，
 *   加分卡由 `card_uses` 承担）。所以这里拿到的永远是当前值，**不需要前端维护计数器** ——
 *   前端一旦自己也减，就会与「补发欠卡」的机制打架（那条路会在读的时候补齐历史欠账）。
 *
 * ⚠ **读一次会「先补发、再算余额」**：`get_card_balance()` 内部先调
 *   `grant_pending_cards()`，把该发而未发的卡（每周达标、等级里程碑、上线初始发放）补上。
 *   这是本项目刻意的设计（没有调度器 ⇒ 读时补发，幂等由 `card_grants` 唯一键兜底）。
 *   ⇒ 副作用是**这个调用不算便宜**：调用方不应在渲染里反复触发，只在页面装载/补签后各一次。
 *
 * ⚠ **未登录会抛异常**（函数里 `raise exception 'not authenticated'`）⇒
 *   游客必须 **enabled=false**，否则每次打开页面都会多一条失败请求。
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export interface CardBalance {
  /** 补签卡余额（可补的漏签日天数） */
  makeup: number;
  /** 加分卡余额 */
  bonus: number;
}

/** 取不到时的占位值。⚠ 别把它当成"确实是 0 张"来提示 —— 见 `useCardBalance().error`。 */
export const EMPTY_CARD_BALANCE: CardBalance = { makeup: 0, bonus: 0 };

export async function fetchCardBalance(): Promise<CardBalance> {
  const { data, error } = await supabase.rpc('get_card_balance');
  if (error) throw new Error(error.message || 'get_card_balance failed');
  const r = (data ?? {}) as Partial<CardBalance>;
  return { makeup: r.makeup ?? 0, bonus: r.bonus ?? 0 };
}

export interface CardBalanceView {
  balance: CardBalance;
  loading: boolean;
  /** 非空表示**没读到**（此时 `balance` 是占位值，不可当作"0 张"展示）。 */
  error: string;
  reload: () => void;
}

/**
 * 读卡余额。`enabled=false` 时完全不发请求（游客、或切换尚未生效时不该付这个网络开销）。
 *
 * ⚠ 调用方必须区分「读到了 0 张」与「没读到」：两者都显示成 `0` 会把"读失败"
 *   伪装成"你没有卡"，而学生据此会以为努力没被承认 —— 那正是补签卡要避免的观感。
 */
export function useCardBalance(enabled = true): CardBalanceView {
  const [balance, setBalance] = useState<CardBalance>(EMPTY_CARD_BALANCE);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setBalance(EMPTY_CARD_BALANCE);
      setLoading(false);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const b = await fetchCardBalance();
        if (alive) setBalance(b);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setBalance(EMPTY_CARD_BALANCE);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);

  return { balance, loading, error, reload };
}
