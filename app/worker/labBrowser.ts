// 实验路由：验证 Cloudflare Browser Rendering（Browser Run）在本项目环境可用
// —— 为「前端一键同步分数到 ManageBac」做技术验证的第一步。
//
// 安全设计（务必保留）：
//   ① **令牌门禁**：只有请求头 X-Lab-Token 等于 env.LAB_TOKEN 才放行；
//      **本地**在 app/.dev.vars 里设 LAB_TOKEN，**线上不设** → 这条路由在生产等于不存在（404）。
//   ② **目标白名单**：只允许访问 managebac.com 与本机/示例站点，避免被当成任意 URL 的抓取器（SSRF）。
//   ③ 不写入任何数据：本路由只做「打开页面 + 截图 + 回报标题/状态」，是纯只读验证。
//
// 用法（本地）：
//   curl -H "X-Lab-Token: <app/.dev.vars 里的值>" -X POST \
//     "http://127.0.0.1:8787/app-api/lab/browser-check?url=https://example.com"

import puppeteer from '@cloudflare/puppeteer';
import { cdpSelfCheck, type MbApiEnv } from './mbApi';

export interface LabBrowserEnv {
  BROWSER: Fetcher;
  LAB_TOKEN?: string;
  BROWSER_ACCOUNT_ID?: string;
  BROWSER_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  // 下面几个用于 /app-api/lab/ai-probe：从 CF 边缘探测各 AI 通道的出口可达性
  AGNES_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  MODELSCOPE_API_KEY?: string;
}

const ALLOW_HOSTS = [
  'example.com',
  'www.example.com',
  'managebac.com',
  'www.managebac.com',
  // ManageBac 也有 .cn 顶级域（本校用的是 dtd.managebac.cn）
  'managebac.cn',
  'www.managebac.cn',
];

function allowed(url: string): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'bad url' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'bad protocol' };
  const host = u.hostname.toLowerCase();
  if (ALLOW_HOSTS.includes(host)) return { ok: true, url: u.toString() };
  // 学校专属子域形如 <school>.managebac.com
  if (host.endsWith('.managebac.com')) return { ok: true, url: u.toString() };
  return { ok: false, reason: `host not allowed: ${host}` };
}

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** 返回 null 表示不是本模块负责的路径 */
export async function handleLabBrowser(
  request: Request,
  env: LabBrowserEnv,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/app-api/lab/')) return null;

  // 令牌门禁：未配置 LAB_TOKEN（线上常态）时直接当作不存在
  const token = env.LAB_TOKEN ?? '';
  if (!token || request.headers.get('X-Lab-Token') !== token) {
    return json(404, { error: 'not found' });
  }

  if (url.pathname === '/app-api/lab/browser-check') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    const target = url.searchParams.get('url') ?? 'https://example.com';
    const gate = allowed(target);
    if (!gate.ok) return json(400, { error: 'target not allowed', detail: gate.reason });

    const t0 = Date.now();
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      const res = await page.goto(gate.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const title = await page.title();
      const shot = (await page.screenshot({ encoding: 'base64', type: 'png' })) as unknown as string;
      return json(200, {
        ok: true,
        target: gate.url,
        httpStatus: res?.status() ?? null,
        title,
        elapsedMs: Date.now() - t0,
        screenshotBase64: shot,
        screenshotBytes: Math.round((shot.length * 3) / 4),
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return json(502, { error: 'browser check failed', detail: msg.slice(0, 400), elapsedMs: Date.now() - t0 });
    } finally {
      try {
        await browser?.close();
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }

  // 诊断：binding 的能力面 + 不需要"会话"的 Quick Action（用于区分"服务整体不可用"与"仅会话受限"）
  if (url.pathname === '/app-api/lab/browser-info') {
    const b = env.BROWSER as unknown as Record<string, unknown>;
    return json(200, {
      ok: true,
      keys: Object.keys(b),
      methods: Object.keys(b).filter((k) => typeof b[k] === 'function'),
    });
  }

  // 通路自检：**REST + CDP**（另一条通路，见 mbApi.ts 顶部说明）
  // 背景（2026-09-16 实测）：本账号下 puppeteer binding 创建浏览器会失败
  //   `Unable to create new browser: code: 500: internal error`，
  // 而 REST + CDP 稳定可用 —— ManageBac 抓取因此走这条。这个端点用来单独确认通路本身是否通。
  if (url.pathname === '/app-api/lab/cdp-check') {
    const target = url.searchParams.get('url') ?? 'https://example.com';
    const gate = allowed(target);
    if (!gate.ok) return json(400, { error: 'target not allowed', detail: gate.reason });
    try {
      const r = await cdpSelfCheck(env as unknown as MbApiEnv, gate.url);
      return json(200, { ok: true, target: gate.url, ...r });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return json(502, { error: 'cdp check failed', detail: msg.slice(0, 400) });
    }
  }

  if (url.pathname === '/app-api/lab/browser-quick') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    const target = url.searchParams.get('url') ?? 'https://example.com';
    const action = url.searchParams.get('action') ?? 'screenshot';
    const gate = allowed(target);
    if (!gate.ok) return json(400, { error: 'target not allowed', detail: gate.reason });
    const b = env.BROWSER as unknown as { quickAction?: (a: string, o: unknown) => Promise<Response> };
    if (typeof b.quickAction !== 'function') return json(501, { error: 'no quickAction on binding' });
    const t0 = Date.now();
    try {
      const r = await b.quickAction(action, { url: gate.url });
      const buf = new Uint8Array(await r.arrayBuffer());
      return json(200, {
        ok: r.ok,
        action,
        status: r.status,
        contentType: r.headers.get('content-type'),
        bytes: buf.length,
        elapsedMs: Date.now() - t0,
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return json(502, { error: 'quick action failed', detail: msg.slice(0, 400), elapsedMs: Date.now() - t0 });
    }
  }

  // AI 通道连通性探测：**从 CF 边缘真实发起**，用于区分「端点/服务问题」与「CF 出口被拒」。
  // 典型用途：Agnes 国际站(.com) 与国内节点(.cn) 在 Worker 出口的可达性对比
  // （2026-09-21：当年「CF 出口恒 1015」的结论疑似就是打了国际站所致）。
  if (url.pathname === '/app-api/lab/ai-probe') {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0 Safari/537.36';
    const targets: [string, string, string, string, boolean][] = [
      ['agnes-cn', 'https://apihub.agnes-ai.cn/v1/chat/completions', 'agnes-2.5-flash', env.AGNES_API_KEY ?? '', false],
      ['agnes-com', 'https://apihub.agnes-ai.com/v1/chat/completions', 'agnes-2.5-flash', env.AGNES_API_KEY ?? '', false],
      ['openrouter-ultra', 'https://openrouter.ai/api/v1/chat/completions',
        'nvidia/nemotron-3-ultra-550b-a55b:free', env.OPENROUTER_API_KEY ?? '', false],
      ['modelscope', 'https://api-inference.modelscope.cn/v1/chat/completions',
        'Qwen/Qwen3.5-122B-A10B', env.MODELSCOPE_API_KEY ?? '', true],
    ];
    const results: Record<string, unknown>[] = [];
    for (const [name, endpoint, model, key, needThinkingFlag] of targets) {
      const t0 = Date.now();
      if (!key) {
        results.push({ name, status: -1, error: 'no key in env' });
        continue;
      }
      const body: Record<string, unknown> = {
        model, messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        max_tokens: 16, stream: false, temperature: 0,
      };
      if (needThinkingFlag) body.enable_thinking = false;   // 魔搭：关思考
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': UA },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        results.push({ name, status: r.status, ms: Date.now() - t0, snippet: text.slice(0, 220) });
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        results.push({ name, status: 0, ms: Date.now() - t0, error: msg.slice(0, 220) });
      }
    }
    return json(200, { ok: true, from: 'cloudflare-edge', results });
  }

  return json(404, { error: 'not found' });
}
