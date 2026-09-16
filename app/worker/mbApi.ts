// 主站 API：ManageBac 同步（教师专用，**只读抓取**）
//
// 端点：
//   POST /app-api/mb/tasks   { classId, code }
//     用教师的 ManageBac 登录态打开该班成绩册的「全部任务」视图，
//     抓出 task 列表（core_tasks/<id> + 名称）并按 [短码] **精确匹配**；
//     **本端点不写任何数据** —— 绑定由前端确认后自行写 mb_task_links。
//
// 鉴权：必须登录 + teacher/developer（因为用的是教师的 ManageBac 凭证）。
// 凭证来源：教师本机脚本 mb-login-local.mjs 登录后同步到 public.mb_sessions；
//           Worker 用**请求自带的教师 JWT** 读出（RLS 生效），本端点侧**只读不写**。
//
// ⚠ 为什么不用 env.BROWSER（puppeteer binding）：
//   本账号下 binding 路径创建浏览器会直接失败 —— 2026-09-16 用 /app-api/lab/browser-check 实测：
//   `Unable to create new browser: code: 500: message: Error: internal error`（耗时 21 秒）。
//   而 REST API（POST /accounts/<id>/browser-rendering/devtools/browser）+ CDP over WebSocket
//   稳定可用（scripts/mb-tasks.mjs、cf-managebac-login.mjs 长期在用）。
//   故这里与本地脚本走**同一条通路**：REST 建会话 → CDP 注入 cookie/导航/取值 → 显式关闭会话。
//   注意：免费额度（10 分钟/天）按**会话存活时间**计，所以任何分支都必须关会话。

import { bearer, isTeacherOrDeveloper, verifyUser } from './ai/auth';
import { cors } from './appApi';

export interface MbApiEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  // Browser Rendering 的账号与令牌。两套名字都认：
  //   BROWSER_* = 首选（2026-09-16 实测 wrangler 似乎不把 `CF_` 前缀的变量注入 Worker，
  //               与它自身的 CLOUDFLARE_* 凭据相避；改名后可用）
  //   CF_*      = 兼容旧名（线上若已用此名配置 secret 则不必改）
  BROWSER_ACCOUNT_ID?: string;
  BROWSER_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
}

const json = (status: number, obj: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

/** 与 src/lib/mbSync.ts 的 shortCodePattern 同口径：方括号 + 精确短码，忽略大小写 */
function shortCodeRe(code: string): RegExp {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[\\s*${esc}\\s*\\]`, 'i');
}

/** 页面内提取 task 列表（与 scripts/mb-tasks.mjs 同一口径：只取 id 与名称，不碰学生数据） */
const TASKS_EXPR = `(() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="core_tasks/"]')) {
    const m = /core_tasks\\/(\\d+)/.exec(a.getAttribute('href') || '');
    if (!m) continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], name: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) });
  }
  return JSON.stringify({ url: location.href, title: document.title, tasks: out });
})()`;

interface MbCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

// ---------- Cloudflare Browser Rendering：REST + CDP ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带退避的 CF API 调用（免费版有「1 个新实例/20 秒」「10 分钟/天」限制，超限返回 429） */
async function cfFetch(url: string, init: RequestInit, apiToken: string, tries = 3): Promise<Response> {
  const headers = { ...((init.headers ?? {}) as Record<string, string>), Authorization: `Bearer ${apiToken}` };
  for (let i = 1; i <= tries; i++) {
    const r = await fetch(url, { ...init, headers });
    if (r.status !== 429 && r.status < 500) return r;
    if (i === tries) return r;
    const ra = Number(r.headers.get('retry-after') || 0);
    await sleep((ra > 0 ? ra : 20) * 1000);
  }
  return fetch(url, { ...init, headers });
}

/** 极简 CDP 客户端（与 scripts/mb-tasks.mjs 的实现同构） */
class Cdp {
  private seq = 0;
  private pending = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();

  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => {
      let m: { id?: number; result?: unknown; error?: unknown };
      try {
        m = JSON.parse(String((ev as MessageEvent).data)) as typeof m;
      } catch {
        return;
      }
      if (typeof m.id !== 'number') return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.no(new Error(JSON.stringify(m.error).slice(0, 240)));
      else p.ok(m.result);
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
  }

  send(method: string, params: unknown = {}): Promise<{ value?: unknown }> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { ok: resolve as (v: unknown) => void, no: reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 求值并取字符串结果（CDP 的 Runtime.evaluate 返回 {result:{type,value}}，注意层级） */
  async text(expression: string): Promise<string> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown } };
    return String(r?.result?.value ?? '');
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 一次「开云端浏览器 → 干活 → 关会话」的完整封装；**任何分支都保证关会话** */
async function withCloudBrowser<T>(
  env: MbApiEnv,
  fn: (cdp: Cdp) => Promise<T>,
): Promise<T> {
  const accountId = env.BROWSER_ACCOUNT_ID ?? env.CF_ACCOUNT_ID ?? '';
  const apiToken = env.BROWSER_API_TOKEN ?? env.CF_API_TOKEN ?? '';
  if (!accountId || !apiToken) {
    // 诊断用：只列键名（不含值），便于区分「没配」与「没加载」
    throw new Error(
      `Worker 缺少 BROWSER_ACCOUNT_ID / BROWSER_API_TOKEN（或旧名 CF_*）—— env 现有键：${Object.keys(env as object).sort().join(', ')}`,
    );
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering`;
  let sessionId = '';
  let cdp: Cdp | null = null;
  try {
    const cr = await cfFetch(`${base}/devtools/browser?keep_alive=120000`, { method: 'POST' }, apiToken);
    const cj = (await cr.json()) as { sessionId?: string; errors?: unknown };
    if (!cr.ok || !cj.sessionId) {
      throw new Error(`创建浏览器会话失败：${JSON.stringify(cj).slice(0, 240)}`);
    }
    sessionId = cj.sessionId;

    const nr = await cfFetch(`${base}/devtools/browser/${sessionId}/json/new?url=about:blank`, { method: 'PUT' }, apiToken);
    const nj = (await nr.json()) as { webSocketDebuggerUrl?: string };
    if (!nr.ok || !nj.webSocketDebuggerUrl) {
      throw new Error(`新建标签页失败：${JSON.stringify(nj).slice(0, 240)}`);
    }

    cdp = await Cdp.connect(nj.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    return await fn(cdp);
  } finally {
    cdp?.close();
    if (sessionId) {
      try {
        await fetch(`${base}/devtools/browser/${sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${apiToken}` } });
      } catch {
        /* 会话会随 keep_alive 自然过期；关闭失败不阻塞返回 */
      }
    }
  }
}

/** 通路自检：用 REST + CDP 打开一个页面并读标题（供 /app-api/lab/cdp-check 用） */
export async function cdpSelfCheck(env: MbApiEnv, target = 'https://example.com'): Promise<{ title: string; elapsedMs: number }> {
  const t0 = Date.now();
  return withCloudBrowser(env, async (cdp) => {
    await cdp.send('Page.navigate', { url: target });
    let title = '';
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      title = await cdp.text('document.title');
      if (title) break;
    }
    return { title, elapsedMs: Date.now() - t0 };
  });
}

/** 用教师 JWT 读云端会话（RLS 保证只读得到本人的那一行） */
async function readSession(userId: string, token: string, env: MbApiEnv): Promise<MbCookie[] | null> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/mb_sessions?select=cookies&teacher_id=eq.${encodeURIComponent(userId)}`,
    { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as { cookies?: MbCookie[] }[];
  const c = rows[0]?.cookies;
  return Array.isArray(c) && c.length ? c : null;
}

/** 返回 null 表示不是 /app-api/mb/* 请求（交回主分发） */
export async function handleMbApi(request: Request, env: MbApiEnv, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/app-api/mb/')) return null;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  const withCors = (res: Response) => {
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(request))) out.headers.set(k, v);
    return out;
  };

  if (url.pathname !== '/app-api/mb/tasks') return withCors(json(404, { error: 'not found' }));
  if (request.method !== 'POST') return withCors(json(405, { error: 'method not allowed' }));

  const token = bearer(request);
  if (!token) return withCors(json(401, { error: '请先登录' }));
  const userId = await verifyUser(token, env);
  if (!userId) return withCors(json(401, { error: '登录已失效，请重新登录' }));
  if (!(await isTeacherOrDeveloper(userId, token, env))) {
    return withCors(json(403, { error: '仅教师可用' }));
  }

  let body: { classId?: string; code?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* 空 body → 下面按缺参处理 */
  }
  const mbClassId = String(body.classId ?? '').replace(/\D/g, '');
  const code = String(body.code ?? '').trim();
  if (!mbClassId) return withCors(json(400, { error: '缺少 classId（ManageBac 班级号）' }));
  if (!code) return withCors(json(400, { error: '缺少 code（短码）' }));

  const cookies = await readSession(userId, token, env);
  if (!cookies) {
    return withCors(
      json(409, {
        error: '云端没有可用的 ManageBac 登录态（或已被清空）',
        hint: '在 app/ 下跑一次 node scripts/mb-login-local.mjs 完成登录，它会自动同步到云端，再回来重试。',
      }),
    );
  }

  const target = `https://dtd.managebac.cn/teacher/classes/${mbClassId}/gradebook/core_tasks`;
  const t0 = Date.now();
  try {
    const info = await withCloudBrowser(env, async (cdp) => {
      await cdp.send('Network.setCookies', {
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
        })),
      });
      await cdp.send('Page.navigate', { url: target });

      // 任务列是前端异步渲染的；同时先看是否落到登录页（cookie 过期时立刻停下，不白等）
      let ready = 0;
      let landedLogin = '';
      for (let i = 0; i < 20; i++) {
        await sleep(1500);
        const href = await cdp.text('location.href');
        if (/\/login/i.test(href)) {
          landedLogin = href;
          break;
        }
        ready = Number(await cdp.text('document.querySelectorAll(\'a[href*="core_tasks/"]\').length')) || 0;
        if (ready > 0) break;
      }
      if (landedLogin) {
        throw Object.assign(new Error('MANAGEBAC_LOGIN_EXPIRED'), { landedLogin });
      }
      return JSON.parse(await cdp.text(TASKS_EXPR)) as {
        url: string;
        title: string;
        tasks: { id: string; name: string }[];
      };
    });

    const re = shortCodeRe(code);
    const matches = info.tasks.filter((t) => re.test(t.name));

    return withCors(
      json(200, {
        ok: true,
        target,
        term: 'current', // 该视图默认只列 current term（多学期要切下拉，暂不遍历）
        taskCount: info.tasks.length,
        tasks: info.tasks,
        match: matches.length === 1 ? matches[0] : null,
        matchCount: matches.length,
        reason:
          matches.length === 1
            ? null
            : matches.length === 0
              ? '该班当前学期的 task 里没有含此短码的；可能还没粘短码，或它在另一个学期'
              : '有多条命中，按约定不猜',
        elapsedMs: Date.now() - t0,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'MANAGEBAC_LOGIN_EXPIRED') {
      return withCors(
        json(409, {
          error: 'ManageBac 登录态已过期',
          hint: '在 app/ 下跑 node scripts/mb-login-local.mjs 重新登录一次（不消耗浏览器额度），再回来点「绑定」。',
          elapsedMs: Date.now() - t0,
        }),
      );
    }
    return withCors(json(502, { error: '抓取失败', hint: msg.slice(0, 400), detail: msg.slice(0, 400), elapsedMs: Date.now() - t0 }));
  }
}
