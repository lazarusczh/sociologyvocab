// 魔搭魔粒「静默保活」
//
// 机制（2026-10-04 实测确定，详见 project-memory.md）：
//   余额 = 100（长期有效） + 每次「登录行为」触发的 250（**滚动 24 小时**有效、可叠加）
//   **带令牌的 OpenAPI 请求本身就触发那 250**，但到账有约 1 分钟延迟
//   而魔搭推理域（api-inference.modelscope.cn）的调用**不算**活跃 ⇒ 必须单独打下面这个端点
//
// 所以就按「机会型触发」：任何人用到 AI 功能时顺手 ping 一次（触发点要早 —— 到账有延迟，
// 等真要走魔搭档时再 ping 就来不及了）。
//
// 三条硬约束：
//   ① 绝不阻塞主流程（调用方用 ctx.waitUntil）；② 绝不因失败影响学生请求（一律静默）；
//   ③ 绝不每次请求都打（20h 节流 —— 有效期是滚动 24h，20h 一次足够）。
import { BROWSER_UA } from './models';

/** 魔搭魔粒余额（官方 OpenAPI，全局 bearerAuth；Bearer 就是那个 API key） */
export const MS_BALANCE_URL = 'https://modelscope.cn/openapi/v1/magicubes/balance';

// 节流标记：用 Cache API 存，不新增 KV binding、不建表、不动 Supabase
const FLAG_URL = 'https://ms-keepalive.internal/last-ping';
const CACHE_THROTTLE_SECONDS = 20 * 60 * 60; // 20h
const MEM_THROTTLE_MS = 60 * 60 * 1000;      // 同 isolate 内兜底（Cache 被驱逐/不可用时）

let memLastPing = 0;

/**
 * 调用方唯一入口：安全地排一次保活。
 *
 * **绝不让保活影响学生请求** —— 这里把「取 ctx / 排任务」整段裹在 try 里：
 * 即便 ctx 异常、waitUntil 不可用，也只是少一次保活，不会把 AI 路由打成 500。
 */
export function scheduleKeepalive(
  env: { MODELSCOPE_API_KEY?: string },
  ctx: ExecutionContext | undefined,
): void {
  try {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(keepaliveMagicube(env));
    else void keepaliveMagicube(env);
  } catch (e) {
    console.log(`[ms-keepalive] schedule failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 打一次魔搭公开 OpenAPI，让它发放当日那 250 魔粒。
 *
 * 调用方务必 `ctx.waitUntil(keepaliveMagicube(env))`，不要 await 在响应路径上。
 * 只读、不消耗魔粒；请求本身就是「活跃」，因此也是保活。
 */
export async function keepaliveMagicube(env: { MODELSCOPE_API_KEY?: string }): Promise<void> {
  const key = env.MODELSCOPE_API_KEY;
  if (!key) return;

  // ① 同 isolate 兜底节流
  const now = Date.now();
  if (now - memLastPing < MEM_THROTTLE_MS) return;
  // 先记上：无论后面成败都节流 1 小时 —— 否则「Cache API 不可用」这类异常路径
  // 会在每个请求上重试，反而变成刷接口
  memLastPing = now;

  try {
    // ② 跨 isolate 节流（Cache API 是数据中心内的，最坏只是多 ping 几次，无害）
    const cached = await caches.default.match(FLAG_URL);
    if (cached) return;

    const res = await fetch(MS_BALANCE_URL, {
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
      },
    });
    const body = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: { available_balance?: number; total_balance?: number } }
      | null;
    console.log(
      `[ms-keepalive] HTTP ${res.status} available=${body?.data?.available_balance ?? 'n/a'} total=${body?.data?.total_balance ?? 'n/a'}`,
    );

    // ③ 无论成功与否都记标记：魔搭抖动时重打也没有意义，反而像在刷接口
    await caches.default.put(
      FLAG_URL,
      new Response('1', { headers: { 'Cache-Control': `max-age=${CACHE_THROTTLE_SECONDS}` } }),
    );
  } catch (e) {
    // 保活失败绝不影响调用方
    console.log(`[ms-keepalive] skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}
