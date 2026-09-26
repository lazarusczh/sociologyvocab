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

/** 待写入盘的事件缓冲（见 `enqueueXpEvents` 的合并说明）。 */
let buf: QueuedEvent[] = [];
let bufTimer = 0;

/**
 * 入队（**同步、不抛**，可在练习流程里直接调）。
 * 传 uid 而非内部取 session：调用方（store）本来就知道当前用户，能省掉一次异步等待 ——
 * 异步等待期间若用户刷新页面，事件就丢了。
 *
 * ★ 同一 tick 内的多次调用**合并成一次写盘**（2026-09-26）：
 *   `QuizTaker` 交卷时会**连续调用 `recordItem` 记整份作业**（通常 20 个词条），
 *   若每条各读一次、各写一次 localStorage，就是 20 次同步 I/O；更要紧的是
 *   ——写盘若分散在多个 tick，`flushXpQueue` 可能在**只落盘了一部分**时就启动，
 *   于是只发出去一小部分（这正是 2026-09-24 那份作业丢 19/20 条的机制）。
 *   合并后：一次写盘落全，`flushXpQueue` 读到的就是完整的这一批。
 */
export function enqueueXpEvents(events: XpEvent[], uid: string): void {
  if (!uid || events.length === 0) return;
  for (const e of events) buf.push({ ...e, uid });
  if (bufTimer) return;
  // 0ms 定时器：让同一同步块内的多次调用汇入同一批
  bufTimer = setTimeout(flushEnqueueBuffer, 0) as unknown as number;
}

/** 把缓冲区一次性落到 localStorage（超限时丢最旧的）。 */
function flushEnqueueBuffer(): void {
  bufTimer = 0;
  if (buf.length === 0) return;
  const all = buf;
  buf = [];
  const q = dropExpired(readQueue());
  q.push(...all);
  // 超限丢最旧（数组尾是最新）
  writeQueue(q.length > QUEUE_MAX ? q.slice(q.length - QUEUE_MAX) : q);
}

/** 当前待补报条数（供 UI 提示「有 N 条待同步」）。**含尚未落盘的缓冲**（同步调用后立刻读也准确）。 */
export function pendingXpCount(): number {
  return readQueue().length + buf.length;
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
  if (flushing) return { sent: 0, remaining: pendingXpCount(), failed: false };
  flushing = true;
  try {
    // ★ 先把入队缓冲落盘：它是 `setTimeout(0)` 写的**宏任务**，而本函数的 `await` 续跑是
    //   **微任务**（会先于宏任务）—— 不先落盘，就读不到刚入队的那一批。
    flushEnqueueBuffer();

    // 预检：真的没活干才快速返回（心跳每 60 秒调一次，绝大多数时候是空的）
    if (readQueue().length === 0) return { sent: 0, remaining: 0, failed: false };

    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user?.id ?? '';

    // ★★ 读队列**必须**在 `await` 之后，且要**再落一次缓冲** —— 这里曾是一个丢数据的 bug
    //   （2026-09-26 找到）：`QuizTaker` 交卷时一次性调用 `recordItem` 记整份作业
    //   （作业通常 20 个词条），若在 `await` 之前读，flush 会**抢跑**、手里只有最初那一两条
    //   ⇒ 发出去 ⇒ 队列空 ⇒ 退出；剩余的要等 15 秒节流或 60 秒心跳，而学生**交卷后往往
    //   立刻离开页面** ⇒ 事件留在 localStorage。
    //   实测（学生 8eb7e807，2026-09-24）：作业 20 个词条 ⇒ 服务端只收到 **1 条**，丢 19 条；
    //   而同一天**交卷前的 20 题日常练习（逐题、间隔几十秒）一条未丢** —— 逐题时每次 flush
    //   都能拿到当时的全部。⇒ 只有「批量入队」会中招，且**与设备/网络无关**。
    flushEnqueueBuffer();
    let queue = dropExpired(readQueue());
    if (queue.length === 0) {
      writeQueue(queue);
      return { sent: 0, remaining: 0, failed: false };
    }

    // 未登录：保留队列等登录后再发（不丢，也不替别人发）
    if (!uid) {
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
  // 回到前台补发；**转入后台也发一次** —— 学生切走/关页面前那一刻，刚做的题已在队列里，
  // 这是最有可能成功的一次机会（`beforeunload` 太晚，异步请求常被浏览器中断）。
  const onVisibility = () => {
    if (document.visibilityState === 'visible') tryFlush();
    else void flushXpQueue();
  };

  window.addEventListener('online', tryFlush);
  document.addEventListener('visibilitychange', onVisibility);
  const timer = window.setInterval(tryFlush, intervalMs);
  tryFlush(); // 启动即补上次未发完的

  const stop = () => {
    window.removeEventListener('online', tryFlush);
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearInterval(timer);
    stopSync = null;
  };
  stopSync = stop;
  return stop;
}
