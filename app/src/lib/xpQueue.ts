// XP 事件本地队列：离线暂存 + 联网补报。
//
// 为什么必须有队列（而不是「上报失败就算了」）：
//   学生一次练习常持续几十分钟，中途断网、切后台、锁屏、关页面都很常见。
//   若失败即丢，学生会看到「我明明练了但没加分」—— 这是最伤信任的一类 bug，
//   而且**无法事后补救**（事件已经不存在了）。
//
// 幂等由 event_id 保证（见 ./xp.ts）：队列可以放心重试，
// 服务端把重复的记为 duplicated、不二次计分。
//
// ⚠ 归属校验：每条事件落盘时带上「当时的 uid」。补报前若当前登录 uid 与事件 uid 不符，
//   直接丢弃 —— 防止「A 在这台设备练完、B 登录后替 A 补报」。

import { supabase } from './supabase';
import { submitXpEvents, SUBMIT_BATCH_MAX, type XpEvent } from './xp';

const QUEUE_KEY = 'socio_xp_queue';

/** 队列长度上限：超出时丢**最旧**的。
 *  XP 是激励不是账本 —— 宁可丢极少数历史，也不让 localStorage 无限膨胀（写满会连累其他模块）。 */
const QUEUE_MAX = 500;

/** 超过这个年龄的事件直接丢弃：服务端只接受 72 小时内的补报（防线 #2），
 *  留着也只会被拒，不如提前清掉。 */
const MAX_AGE_MS = 72 * 60 * 60 * 1000;

interface QueuedEvent extends XpEvent {
  uid: string;
}

function readQueue(): QueuedEvent[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as QueuedEvent[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeQueue(q: QueuedEvent[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    // 存储写满 / 隐私模式：静默失败。练习体验优先，XP 丢一两条也不该打断作答。
  }
}

/** 丢掉超龄事件（服务端必然拒收的那部分）。先丢再上报，省一次无谓往返。 */
function dropExpired(q: QueuedEvent[]): QueuedEvent[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return q.filter((e) => {
    const t = Date.parse(e.answered_at);
    return !Number.isFinite(t) || t >= cutoff;
  });
}

/**
 * 入队（**同步、不抛**，可在练习流程里直接调）。
 * 传 uid 而非内部取 session：调用方（store）本来就知道当前用户，能省掉一次异步等待 ——
 * 异步等待期间若用户刷新页面，事件就丢了。
 */
export function enqueueXpEvents(events: XpEvent[], uid: string): void {
  if (!uid || events.length === 0) return;
  const q = dropExpired(readQueue());
  for (const e of events) q.push({ ...e, uid });
  // 超限丢最旧（数组尾是最新）
  writeQueue(q.length > QUEUE_MAX ? q.slice(q.length - QUEUE_MAX) : q);
}

/** 当前待补报条数（供 UI 提示「有 N 条待同步」）。 */
export function pendingXpCount(): number {
  return readQueue().length;
}

/** 清空队列（仅测试/调试用；正常情况下不要调，会丢学生已积累的事件）。 */
export function clearXpQueue(): void {
  try {
    localStorage.removeItem(QUEUE_KEY);
  } catch {
    /* 忽略 */
  }
}

let flushing = false;

/**
 * 尝试把队列全部发出去。**可安全重复调用**（内部有并发锁）。
 *
 * 不抛错 —— 调用方是「联网事件 / 心跳 / 启动」这类无处 try 的地方。
 * 返回 failed 供 UI 判断是否要提示，一般不提示（静默重试即可）。
 */
export async function flushXpQueue(): Promise<{
  sent: number;
  remaining: number;
  failed: boolean;
}> {
  if (flushing) return { sent: 0, remaining: readQueue().length, failed: false };
  flushing = true;
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user?.id ?? '';

    let queue = dropExpired(readQueue());
    // 未登录：保留队列等登录后再发（不丢，也不替别人发）
    if (!uid || queue.length === 0) {
      writeQueue(queue);
      return { sent: 0, remaining: queue.length, failed: false };
    }

    // 归属不符的（通常意味着换过账号）直接丢弃
    const before = queue.length;
    queue = queue.filter((e) => e.uid === uid);
    if (queue.length !== before) {
      console.warn(`[xp] 丢弃 ${before - queue.length} 条非本账号的事件`);
      writeQueue(queue);
    }

    let sent = 0;
    let failed = false;

    while (queue.length > 0) {
      const batch = queue.slice(0, SUBMIT_BATCH_MAX);
      let result;
      try {
        result = await submitXpEvents(batch);
      } catch (err) {
        // 网络层失败：整批留在队列，等下次 flush 再试。
        // 不在此处累加「重试次数」——服务端已用 72 小时窗口兜底，
        // 客户端再设一道次数上限只会在断网较久时白白丢掉学生的事件。
        failed = true;
        console.warn('[xp] 上报失败，已留队列待补报：', (err as Error)?.message ?? err);
        break;
      }

      sent += result.accepted + result.duplicated;
      if (result.rejected.length > 0) {
        // 业务性拒绝（too_old / settled_month / bad_mode…）：重试多少次结果都一样 ⇒ 出队
        console.warn('[xp] 服务端拒收事件：', result.rejected);
      }
      // 整批都已裁定（接受 / 重复 / 拒绝），全部出队
      queue = queue.slice(batch.length);
      writeQueue(queue);
    }

    return { sent, remaining: queue.length, failed };
  } finally {
    flushing = false;
  }
}

let lastFlushAt = 0;
const FLUSH_THROTTLE_MS = 15_000;

/**
 * 「尽快发一次」的节流入口 —— 供练习流程在每次作答后调用。
 *
 * 为什么不直接 await flushXpQueue()：学生一分钟能做 4 道以上的题，
 * 每答一题打一次网络请求既浪费流量也拖慢界面。这里做 15 秒节流，
 * 真正兜底的是 startXpSync 的心跳（联网 / 回前台 / 定时）。
 */
export function requestXpFlush(): void {
  const now = Date.now();
  if (now - lastFlushAt < FLUSH_THROTTLE_MS) return;
  lastFlushAt = now;
  void flushXpQueue();
}

let stopSync: (() => void) | null = null;

/**
 * 启动补报心跳：启动即试一次，之后在「重新联网 / 回到前台 / 每 60 秒」时各试一次。
 *
 * 为什么要三种触发：各自覆盖不同的场景 ——
 *   · `online`           —— 断网恢复（最典型）
 *   · visibilitychange   —— 从后台切回（手机锁屏解锁后不会触发 online）
 *   · 定时                —— 网络一直"在线"但请求偶发失败的情况
 *
 * 重复调用是安全的（第二次直接返回，不会叠加监听器）。返回停止函数。
 */
export function startXpSync(intervalMs = 60_000): () => void {
  if (stopSync) return stopSync;

  const tryFlush = () => {
    void flushXpQueue();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') tryFlush();
  };

  window.addEventListener('online', tryFlush);
  document.addEventListener('visibilitychange', onVisible);
  const timer = window.setInterval(tryFlush, intervalMs);
  tryFlush(); // 启动即补上次未发完的

  const stop = () => {
    window.removeEventListener('online', tryFlush);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(timer);
    stopSync = null;
  };
  stopSync = stop;
  return stop;
}
