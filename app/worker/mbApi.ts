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

/**
 * 页面内提取成绩册行（**只读**：学生名与分数框的当前值，一个字段都不写）。
 * 结构依据 2026-09-15 的行级勘探（app/_ocrlab_out/mb-rows-*.json）：
 *   行 = div.grid-table-row.student-grade；第一个 div.column 是学生列（名字在 <a title="… | 显示名">），
 *   分数框 = input[name="core_task[grades][score]"]（其 id 是成绩记录 id，不是学生 id）。
 */
// 写入诊断开关（2026-09-18 写入跑通后默认关闭）。
// 排查 ManageBac 写入问题时改成 true：会 dump 页面 URL、改完 DOM 的值、重载后的服务端值、
// 写入期间的非 GET 请求、表单结构与按钮清单。这些只在线上日志里看，前端不再展示
// （教师反馈日志太长）。改此开关后需重新 ship 才生效。
const MB_WRITE_DIAG = false;

/** 写入路径在「学生行渲染出来」之后**还要再等多久**才动手（毫秒）。
 *
 * 2026-09-28 教师报「第一个录入的学生的成绩录不进去；只录一个人时那个人也录不进去」。
 * 成绩册的行出来得早（服务端渲染），而给分数框挂"失焦保存"的是页面自己的脚本（就绪得晚）。
 * 我们的写入若抢在后者之前，就会出现最讨厌的那种失败：值进了 DOM、失焦也发生了，
 * 但**一条保存请求都没发**，回读时那一行还是空的
 * （同一页里重写也没用 —— 见写入路由里「补写一遍」的说明）。
 * 这个等待就是为它准备的：让**第一行**的写入落在页面就绪之后。 */
const WRITE_SETTLE_MS = 2000;

const MARKS_EXPR = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const rows = [];
  for (const r of document.querySelectorAll('div.grid-table-row.student-grade')) {
    const cols = r.querySelectorAll(':scope > div.column');
    const nameCol = cols[0] || null;
    const a = nameCol ? nameCol.querySelector('a') : null;
    const title = a ? (a.getAttribute('title') || '') : '';
    const tail = clean((title.split('|').pop() || ''));
    const scoreEl = r.querySelector('input[name="core_task[grades][score]"]');
    rows.push({
      name: tail || clean(nameCol ? nameCol.textContent : ''),
      alt: clean(nameCol ? nameCol.textContent : '').slice(0, 80),
      score: scoreEl ? clean(String(scoreEl.value == null ? '' : scoreEl.value)) : '',
      scoreBox: !!scoreEl,
    });
  }
  return JSON.stringify({ url: location.href, title: document.title, count: rows.length, rows });
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

  /** CDP 事件订阅（`Network.*` 这类**没有 id** 的通知）。
   *
   * 2026-09-18 加：此前这里只处理带 id 的响应、把事件**直接丢弃**，
   * 导致"写完到底有没有向 ManageBac 发保存请求"完全是黑盒 ——
   * 只能看到 DOM 值变了、服务端却没存，无从判断断在哪一环。 */
  private listeners = new Map<string, ((p: Record<string, unknown>) => void)[]>();

  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => {
      let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
      try {
        m = JSON.parse(String((ev as MessageEvent).data)) as typeof m;
      } catch {
        return;
      }
      // 无 id ⇒ 事件通知，分发给订阅者
      if (typeof m.id !== 'number') {
        const hs = m.method ? this.listeners.get(m.method) : undefined;
        if (hs) for (const h of hs) h(m.params ?? {});
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.no(new Error(JSON.stringify(m.error).slice(0, 240)));
      else p.ok(m.result);
    });
  }

  /** 订阅 CDP 事件；返回取消订阅的函数 */
  on(method: string, fn: (p: Record<string, unknown>) => void): () => void {
    const arr = this.listeners.get(method) ?? [];
    arr.push(fn);
    this.listeners.set(method, arr);
    return () => {
      const cur = this.listeners.get(method) ?? [];
      this.listeners.set(method, cur.filter((f) => f !== fn));
    };
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

  const route = url.pathname;
  if (route !== '/app-api/mb/tasks' && route !== '/app-api/mb/marks' && route !== '/app-api/mb/write') {
    return withCors(json(404, { error: 'not found' }));
  }
  if (request.method !== 'POST') return withCors(json(405, { error: 'method not allowed' }));

  const token = bearer(request);
  if (!token) return withCors(json(401, { error: '请先登录' }));
  const userId = await verifyUser(token, env);
  if (!userId) return withCors(json(401, { error: '登录已失效，请重新登录' }));
  if (!(await isTeacherOrDeveloper(userId, token, env))) {
    return withCors(json(403, { error: '仅教师可用' }));
  }

  let body: { classId?: string; code?: string; taskId?: string; updates?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* 空 body → 下面按缺参处理 */
  }
  const mbClassId = String(body.classId ?? '').replace(/\D/g, '');
  if (!mbClassId) return withCors(json(400, { error: '缺少 classId（ManageBac 班级号）' }));
  const code = String(body.code ?? '').trim();
  const taskId = String(body.taskId ?? '').replace(/\D/g, '');
  if (route === '/app-api/mb/tasks' && !code) {
    return withCors(json(400, { error: '缺少 code（短码）' }));
  }
  if (route === '/app-api/mb/marks' && !taskId) {
    return withCors(json(400, { error: '缺少 taskId' }));
  }

  const cookies = await readSession(userId, token, env);
  if (!cookies) {
    return withCors(
      json(409, {
        error: '云端没有可用的 ManageBac 登录态（或已被清空）',
        hint: '在 app/ 下跑一次 node scripts/mb-login-local.mjs 完成登录，它会自动同步到云端，再回来重试。',
      }),
    );
  }

  // cookie 转成 CDP 需要的形态（两个端点共用）
  const cookieParams = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
  }));

  // ---- 只读：读该 task 的成绩册行（供前端做差异预览，一个字段都不写）----
  if (route === '/app-api/mb/marks') {
    const t0 = Date.now();
    try {
      const info = await withCloudBrowser(env, async (cdp) => {
        await cdp.send('Network.setCookies', { cookies: cookieParams });
        return openTaskGradebook(cdp, mbClassId, taskId);
      });
      return withCors(
        json(200, { ok: true, target: info.url, count: info.count, rows: info.rows, elapsedMs: Date.now() - t0 }),
      );
    } catch (e) {
      return withCors(marksError(e, t0));
    }
  }

  // ---- 写入：把分数写进该 task 的成绩册（破坏性操作；写完立即回读校验）----
  // 只写 `core_task[grades][score]` 这一个输入框，不动姓名/备注等任何其它字段。
  // 写什么值由调用方决定：试卷成绩传折算分，测验/作业传原始分（教师 2026-09-16 定）。
  if (route === '/app-api/mb/write') {
    const t0 = Date.now();
    if (!Array.isArray(body.updates) || body.updates.length === 0) {
      return withCors(json(400, { error: '缺少 updates（要写入的行）' }));
    }
    const updates = (body.updates as { row?: unknown; score?: unknown }[])
      .map((u) => ({ row: String(u?.row ?? '').trim(), score: String(u?.score ?? '').trim() }))
      .filter((u) => u.row && u.score);
    if (updates.length === 0) return withCors(json(400, { error: 'updates 里没有有效的行' }));
    if (updates.length > 200) return withCors(json(400, { error: '一次最多写 200 行' }));

    try {
      const result = await withCloudBrowser(env, async (cdp) => {
        await cdp.send('Network.setCookies', { cookies: cookieParams });
        await navigateToTask(cdp, mbClassId, taskId);
        // ⚠ 写入路径要比读取路径多等一步「页面就绪」（settle）——见 WRITE_SETTLE_MS 的说明：
        //   学生行是服务端渲染的、出来得早，而给分数框挂"失焦保存"的是页面自己的脚本（就绪得晚）。
        //   抢在它之前写第一行，就会出现「值进了 DOM、一条保存请求都没发」的静默失败。
        if (!(await waitStudentRows(cdp, WRITE_SETTLE_MS))) throw new Error('没读到学生行（该 task 可能还没有学生）');

        // 记录当前页面 URL —— 用来确认进的到底是「单 task 页」
        // （形态 `/gradebook/term/<term>/core_tasks/<taskId>`）还是学期综合成绩册。
        const pageUrl = MB_WRITE_DIAG ? await cdp.text('location.href') : '';

        // 保存请求哨兵：写入期间到底有没有**真的往 ManageBac 发写请求**。
        // 2026-09-18 就是靠它才发现「写完一条保存请求都没发」；现在**常开**（只累加一个计数），
        // 因为「值在分数框里」与「服务端收到写请求」是两件事 ——
        // 逐行记下请求数，前端报告里就能直接看出那一行是"没发"还是"发了没生效"。
        // 开关只影响是否额外留 URL/状态码明细。
        let saveCount = 0;
        const saveRequests: string[] = [];
        const saveResponses: string[] = [];
        const offReq = cdp.on('Network.requestWillBeSent', (p) => {
          const req = p.request as { method?: string; url?: string } | undefined;
          const u = String(req?.url ?? '');
          if (req?.method && req.method !== 'GET' && /managebac\.(cn|com)/i.test(u)) saveCount++;
          if (MB_WRITE_DIAG && req?.method && req.method !== 'GET' && saveRequests.length < 20) {
            saveRequests.push(`${req.method} ${u.slice(0, 130)}`);
          }
        });
        const offRes = cdp.on('Network.responseReceived', (p) => {
          if (!MB_WRITE_DIAG) return;
          const resp = p.response as { status?: number; url?: string } | undefined;
          const u = String(resp?.url ?? '');
          if (u && !/\.(png|jpe?g|gif|svg|css|js|woff2?|ico)(\?|$)/i.test(u) && saveResponses.length < 20) {
            saveResponses.push(`${resp?.status ?? '?'} ${u.slice(0, 110)}`);
          }
        });

        const located = JSON.parse(await cdp.text(locateExpr(updates))) as {
          row: string;
          score?: string;
          ok: boolean;
          reason?: string;
          inputId?: string;
          before?: string;
        }[];

        // 诊断：这个页面到底靠什么提交？
        //
        // 2026-09-18 实测发现：写入期间**没有任何发往 dtd.managebac.cn 的请求** ——
        // 20 条非 GET 全是 Clarity / New Relic 埋点 ⇒ 分数框改完根本不触发自动保存。
        // 此前注释写「ManageBac 是失焦自动保存型」是**推测，而且错了**。
        // 字段名 `core_task[grades][score]` 是 Rails 嵌套参数风格 ⇒ 大概率是表单 + 显式提交。
        // 所以这里把表单信息和按钮清单 dump 出来，据此决定该点哪个按钮 / 提交哪个表单。
        const formInfo = MB_WRITE_DIAG ? await cdp.text(`(() => {
  const el = document.querySelector('input[name="core_task[grades][score]"]');
  const form = el && el.form ? el.form : null;
  const btns = Array.from(document.querySelectorAll('button, input[type=submit], a.btn, a.button'))
    .slice(0, 25)
    .map((b) => ({
      tag: b.tagName,
      type: b.getAttribute('type') || '',
      text: (b.textContent || b.value || '').replace(/\\s+/g, ' ').trim().slice(0, 28),
      id: b.id || '',
      cls: String(b.className || '').slice(0, 36),
      hidden: b.offsetParent === null,
    }));
  return JSON.stringify({
    hasForm: !!form,
    action: form ? (form.getAttribute('action') || '') : '',
    method: form ? (form.getAttribute('method') || '') : '',
    btns,
  });
  })()`) : '';

        // **真实输入**：真实鼠标点击（拿浏览器级焦点）→ 全选清空 → 逐字符键入 → Tab 失焦。
        // 为什么不是 `el.focus()` + `Input.insertText`，见 typeIntoScoreInput 顶部说明
        // ——那正是 2026-09-18「写进去失败、再查又会变空」的原因。
        const written: {
          row: string;
          ok: boolean;
          reason?: string;
          before?: string;
          after?: string;
          steps?: string[];
        }[] = [];
        // 写入后页面上可见的按钮 / 是否在表单里（每个学生记一条，用于判断提交机制）
        const postWriteUi: string[] = [];
        for (const t of located) {
          if (!t.ok) {
            written.push({ row: t.row, ok: false, reason: t.reason ?? '定位失败' });
            continue;
          }
          const want = t.score ?? '';

          // **每行独立走一遍「重新定位 → 写入 → 自校验」，最多两次**（2026-09-21 改）。
          //
          // 为什么不再用最开始那次 locate 拿到的 inputId：
          //   写一行就会触发成绩册重渲染，后面那些行的 DOM 可能已经被替换，旧引用失效。
          //   而 `typeIntoScoreInput` 是「先 Ctrl+A+Backspace 清空、再逐字符键入」——
          //   一旦"清空成功、键入落空"，该行就从**有值变成空**，随后失焦把空值提交上去。
          //   这正是教师看到的「十几个一起填，有几个读回是空值」，也解释了为什么
          //   "重试几次能成两个、总剩一个进不去"（随机丢值，不是某行天生不可写）。
          let rowOk = false;
          let rowNoSave = false;
          let rowSteps: string[] = [];
          let rowBefore = t.before;
          for (let attempt = 1; attempt <= 2; attempt++) {
            if (attempt > 1) await sleep(600); // 让上一轮保存请求飞完、页面稳定下来
            const fresh = JSON.parse(await cdp.text(locateExpr([{ row: t.row, score: want }]))) as {
              ok: boolean;
              reason?: string;
              inputId?: string;
              before?: string;
            }[];
            const hit = fresh[0];
            if (!hit?.ok || !hit.inputId) {
              rowSteps = rowSteps.concat(`[第 ${attempt} 次] 定位失败：${hit?.reason ?? '未知'}`);
              continue;
            }
            rowBefore = hit.before;
            const saveBefore = saveCount;
            const typed = await typeIntoScoreInput(cdp, hit.inputId, want);
            await sleep(300); // 保存请求是异步发出的，给哨兵一点时间累加
            const saveDelta = saveCount - saveBefore;
            rowOk = typed.ok;
            rowNoSave = typed.ok && saveDelta === 0;
            rowSteps = rowSteps.concat(
              typed.steps.map((s) => `[第 ${attempt} 次] ${s}`),
              `[第 ${attempt} 次] 保存请求=+${saveDelta}`,
            );
            // 值在框里、页面也确实提交了 ⇒ 收工；否则再试一次（第二次仍如此就交给回读与补写）
            if (rowOk && !rowNoSave) break;
          }
          written.push({
            row: t.row,
            ok: rowOk,
            before: rowBefore,
            after: rowOk ? want : '',
            steps: rowSteps,
            // 「值写进去了、页面却没发保存请求」是当前最需要被看见的一种失败：
            // 教师报的「第一个录不进去」就是它。它交给下面的**补写**（重载后基线回到服务端值）收口。
            reason: rowOk
              ? (rowNoSave ? '值已进分数框，但页面没有发出保存请求（多半是页面脚本尚未就绪）' : undefined)
              : '两次尝试都没能把值写进分数框',
          });
          // 行间留一口气：每行失焦都会触发一次自动保存请求，紧接着操作下一行容易互相干扰
          await sleep(350);
          // 写入后这个页面**到底有没有可供提交的按钮/表单**（仅诊断开关打开时）。
          // 放在写入之后 dump：有些界面是"改动后才亮出保存按钮"。
          const afterInfo = MB_WRITE_DIAG ? await cdp.text(`(() => {
  const out = { form: null, gradeish: [], gradesBtn: null, inputAttrs: null };
  const inp = document.querySelector('input[name="core_task[grades][score]"]');
  if (inp) {
    out.inputAttrs = {
      id: inp.id,
      cls: String(inp.className || '').slice(0, 70),
      dataAction: inp.getAttribute('data-action') || '',
      dataAttrs: Array.from(inp.attributes).map((a) => a.name).filter((n) => n.startsWith('data-')).join(','),
      readOnly: inp.readOnly === true,
      disabled: inp.disabled === true,
      formId: inp.form ? (inp.form.id || '(无id)') : '',
    };
  }
  if (inp && inp.form) {
    const f = inp.form;
    out.form = {
      action: f.getAttribute('action') || '',
      method: f.getAttribute('method') || '',
      id: f.id || '',
      cls: String(f.className || '').slice(0, 60),
      fieldCount: f.querySelectorAll('input,select,textarea').length,
      subs: Array.from(f.querySelectorAll('button,input[type=submit]')).map((b) =>
        (b.textContent || b.value || '').replace(/\\s+/g, ' ').trim().slice(0, 20)),
    };
  }
  const seen = new Set();
  for (const e of document.querySelectorAll('[class*="save"],[class*="submit"],[data-action*="save"],[data-action*="submit"],[id*="save"],[id*="submit"]')) {
    const key = e.tagName + '|' + (e.id || '') + '|' + String(e.className || '');
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 12) break;
    out.gradeish.push({
      tag: e.tagName,
      text: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 34),
      id: e.id || '',
      cls: String(e.className || '').slice(0, 70),
      dataAction: e.getAttribute('data-action') || '',
    });
  }
  const g = Array.from(document.querySelectorAll('button,a')).find((b) => /Grades?\\b/i.test(b.textContent || ''));
  if (g) {
    out.gradesBtn = {
      tag: g.tagName,
      text: (g.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      id: g.id || '',
      cls: String(g.className || '').slice(0, 90),
      dataAction: g.getAttribute('data-action') || '',
      href: g.getAttribute('href') || '',
      disabled: g.disabled === true,
    };
  }
  return JSON.stringify(out);
  const el = document.querySelector('input[name="core_task[grades][score]"]');
  const form = el && el.form ? el.form : null;
  const btns = Array.from(document.querySelectorAll('button, input[type=submit], a.btn, a.button'))
    .filter((b) => b.offsetParent !== null)
    .slice(0, 15)
    .map((b) => (b.textContent || b.value || '').replace(/\\s+/g, ' ').trim().slice(0, 24))
    .filter(Boolean);
  return JSON.stringify({ hasForm: !!form, btns });
  })()`) : '';
        if (afterInfo) postWriteUi.push(afterInfo);
        }

        // ManageBac 是异步自动保存：**轮询**回读，全部读到期望值就提前结束。
        // 注意（2026-09-16 实测教训）：原来固定等 4 秒就下结论，会误报"未确认落库" ——
        // 实际分数已经写进去了（抓取脚本读回 20/18/17 三个值），只是页面/服务端还没跟上。
        //
        // ⚠⚠ **2026-09-18 关键修正：回读前必须重新加载页面！**
        //   本段读的是 `input.value`，也就是**当前 DOM**。而写入通道里有一条是"原生 setter 改 DOM"，
        //   如果直接在同一个页面会话里回读，读到的就是我们**刚写进去的值** ⇒ 必然判定 saved:true
        //   ⇒ 报"成功"，但服务端到底存没存根本验不出来。教师遇到的"没报错、也没写进去"
        //   正是这个自欺造成的。所以：等自动保存跑完 → **reload** → 再读服务端渲染出的值。
        const key = (s: string) => s.replace(/\s+/g, '').toLowerCase();
        const pick = (rows: { name: string; alt: string; score: string }[], row: string) =>
          rows.find((r) => key(`${r.name}|${r.alt}`).includes(key(row)));
        const allSaved = (rows: { name: string; alt: string; score: string }[]) =>
          updates.every((u) => {
            const hit = pick(rows, u.row);
            return !!hit && hit.score === u.score;
          });

        // ① 先记下"改完 DOM 后的即时值"——仅作诊断，用来区分「DOM 写了但服务端没存」与「压根没写进去」
        const domNow = JSON.parse(await cdp.text(MARKS_EXPR)) as {
          rows: { name: string; alt: string; score: string }[];
        };
        const domVector = updates
          .map((u) => {
            const hit = pick(domNow.rows ?? [], u.row);
            return `${hit ? hit.score : '(缺行)'}`;
          })
          .join('/');

        // ② 给自动保存留出时间，然后**重新加载**该 task 页面
        await sleep(3000);
        await cdp.send('Page.reload', { ignoreCache: false });
        if (!(await waitStudentRows(cdp))) throw new Error('回读时没读到学生行（页面可能未加载完成）');

        let rowsAfter: { name: string; alt: string; score: string }[] = [];
        let rounds = 0;
        for (let i = 0; i < 8; i++) {
          rowsAfter = (JSON.parse(await cdp.text(MARKS_EXPR)) as {
            rows: { name: string; alt: string; score: string }[];
          }).rows ?? [];
          rounds = i + 1;
          if (allSaved(rowsAfter)) break;
          await sleep(1500);
        }
        const vectorOf = (rows: { name: string; alt: string; score: string }[]) =>
          updates
            .map((u) => {
              const hit = pick(rows, u.row);
              return `${hit ? hit.score : '(缺行)'}`;
            })
            .join('/');
        const serverVector = vectorOf(rowsAfter);
        if (domVector !== serverVector) {
          console.error(`[mb/write] 回读不一致：改完 DOM 时=${domVector}，重载后（服务端）=${serverVector}`);
        }

        // ---- 补写一遍：只补**回读失败的行**（教师报的「第一个录入的写不进去」靠它收口）----
        //
        // 为什么必须"重载之后"才补：第 1 遍里"值进了 DOM、服务端却没存"的那些行，
        //   在**同一页**里重写是没用的 —— 框架把"我们写进去的值"当成了自己的基线，
        //   再写同样的值它认为没有变化 ⇒ 仍然不发保存请求。
        //   这正是教师反复遇到的「重试几次、总剩那一行」：那一行不是天生不可写，而是"没有变化"。
        //   而**重载之后**框架的基线回到服务端值，此时写才是真变化、才会提交。
        //   第一行最容易命中这类失败：页面脚本还没就绪，我们的写入先于它，基线就被我们的值污染了
        //   （这也是为什么"只录一个人"时那个人一定录不进去 —— 他永远是这一会话的第一行）。
        // 代价：只有真有行没落库才多走这一轮；第 1 遍全落库时一个字节都不多花。
        //
        // ⚠ 下面这段与第 1 遍是**同一套逐行动作**（重新定位 → 真实输入 → 抢焦提交 → 再回读）。
        //   之所以写成两段而不是抽成一个函数：把改动压在"多补一遍"这一层，不动已经跑通的第 1 遍。
        //   ⇒ 将来改写入动作（typeIntoScoreInput 的用法）时，**两处都要改**。
        const unsaved = updates.filter((u) => {
          const hit = pick(rowsAfter, u.row);
          return !hit || hit.score !== u.score;
        });
        const secondPassRows = unsaved.map((u) => u.row);
        if (unsaved.length) {
          console.error(`[mb/write] 第 1 遍有 ${unsaved.length} 行未落库，页面此时已就绪，补写一遍：${secondPassRows.join('、')}`);
          const located2 = JSON.parse(await cdp.text(locateExpr(unsaved))) as {
            row: string;
            score?: string;
            ok: boolean;
            reason?: string;
            inputId?: string;
            before?: string;
          }[];
          for (const t of located2) {
            if (!t.ok) {
              written.push({ row: t.row, ok: false, reason: `${t.reason ?? '定位失败'}（补写时）` });
              continue;
            }
            const want = t.score ?? '';
            let rowOk = false;
            let rowSteps: string[] = [];
            let rowBefore = t.before;
            for (let attempt = 1; attempt <= 2 && !rowOk; attempt++) {
              if (attempt > 1) await sleep(600);
              const fresh = JSON.parse(await cdp.text(locateExpr([{ row: t.row, score: want }]))) as {
                ok: boolean;
                reason?: string;
                inputId?: string;
                before?: string;
              }[];
              const hit = fresh[0];
              if (!hit?.ok || !hit.inputId) {
                rowSteps = rowSteps.concat(`[补写第 ${attempt} 次] 定位失败：${hit?.reason ?? '未知'}`);
                continue;
              }
              rowBefore = hit.before;
              const saveBefore = saveCount;
              const typed = await typeIntoScoreInput(cdp, hit.inputId, want);
              await sleep(300);
              const saveDelta = saveCount - saveBefore;
              rowOk = typed.ok;
              rowSteps = rowSteps.concat(
                typed.steps.map((s) => `[补写第 ${attempt} 次] ${s}`),
                `[补写第 ${attempt} 次] 保存请求=+${saveDelta}`,
              );
            }
            written.push({
              row: t.row,
              ok: rowOk,
              before: rowBefore,
              after: rowOk ? want : '',
              steps: rowSteps,
              reason: rowOk ? undefined : '补写时两次都没能把值写进分数框',
            });
            await sleep(350);
          }

          // 补写完同样要「等保存 → 重载 → 回读」：这次读到的才是最终真相
          await sleep(3000);
          await cdp.send('Page.reload', { ignoreCache: false });
          if (!(await waitStudentRows(cdp))) throw new Error('补写回读时没读到学生行（页面可能未加载完成）');
          rounds = 0;
          for (let i = 0; i < 8; i++) {
            rowsAfter = (JSON.parse(await cdp.text(MARKS_EXPR)) as {
              rows: { name: string; alt: string; score: string }[];
            }).rows ?? [];
            rounds = i + 1;
            if (allSaved(rowsAfter)) break;
            await sleep(1500);
          }
        }
        const finalVector = vectorOf(rowsAfter);
        if (finalVector !== serverVector) {
          console.error(`[mb/write] 补写后服务端值=${finalVector}（第 1 遍后=${serverVector}）`);
        }

        // 补写过的行在 written 里会出现两次（第 1 遍 + 补写）：按行去重、保留**最后一次**，
        // 否则前端拿到的会是第 1 遍那条（"已提交但未回读到"），与回读到的最终结果不一致。
        const lastOf = new Map<string, (typeof written)[number]>();
        for (const w of written) lastOf.set(w.row, w);
        const verified = Array.from(lastOf.values()).map((w) => {
          const want = updates.find((u) => u.row === w.row)?.score ?? '';
          const hit = pick(rowsAfter, w.row);
          const actual = hit ? hit.score : '';
          return { ...w, want, actual, saved: actual === want };
        });
        offReq();
        offRes();
        return {
          verified,
          rowCount: rowsAfter.length,
          confirmedAll: allSaved(rowsAfter),
          rounds,
          pageUrl,
          domVector,
          serverVector: finalVector,
          /** 补写过的行（空数组 = 第 1 遍就全落库了） */
          secondPassRows,
          /** 写入期间发往 ManageBac 的写请求总数（0 = 页面一条都没发，值得警惕） */
          saveRequestCount: saveCount,
          saveRequests,
          saveResponses,
          formInfo,
          postWriteUi: postWriteUi.slice(0, 2),
          };
      });

      return withCors(
        json(200, { ok: true, classId: mbClassId, taskId, ...result, elapsedMs: Date.now() - t0 }),
      );
    } catch (e) {
      return withCors(marksError(e, t0, '写入'));
    }
  }

  const target = `https://dtd.managebac.cn/teacher/classes/${mbClassId}/gradebook/core_tasks`;
  const t0 = Date.now();
  try {
    const info = await withCloudBrowser(env, async (cdp) => {
      await cdp.send('Network.setCookies', { cookies: cookieParams });
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

/** 导航到某个 task 的成绩册页。
 *  term 路径不自己拼：先到「全部任务」列表，按 taskId 找到页面给出的链接再进 —— term 变了也不用改代码。 */
async function navigateToTask(cdp: Cdp, mbClassId: string, taskId: string): Promise<void> {
  const listUrl = `https://dtd.managebac.cn/teacher/classes/${mbClassId}/gradebook/core_tasks`;
  await cdp.send('Page.navigate', { url: listUrl });

  let links = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(1200);
    if (/\/login/i.test(await cdp.text('location.href'))) throw new Error('MANAGEBAC_LOGIN_EXPIRED');
    links = Number(await cdp.text('document.querySelectorAll(\'a[href*="core_tasks/"]\').length')) || 0;
    if (links > 0) break;
  }
  if (!links) throw new Error('没读到任务列表（该班成绩册可能为空，或页面结构有变）');

  const taskHref = await cdp.text(`(() => {
    const a = document.querySelector('a[href*="core_tasks/${taskId}"]');
    return a ? a.href : '';
  })()`);
  if (!taskHref) throw new Error('当前学期里找不到这个 task —— 它可能已被删除，或在另一个学期');

  await cdp.send('Page.navigate', { url: taskHref });
}

/** 等成绩册的学生行渲染出来；返回行数（0 表示没等到）
 *
 * `settleMs > 0` = 行出现之后**还要再等页面自己就绪**（写入路径必须传，见 WRITE_SETTLE_MS）：
 * 先等 `document.readyState === 'complete'`，再静置 `settleMs`。
 * 读取路径不需要（只读不受影响），默认 0 = 行为不变。 */
async function waitStudentRows(cdp: Cdp, settleMs = 0): Promise<number> {
  let n = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(1200);
    if (/\/login/i.test(await cdp.text('location.href'))) throw new Error('MANAGEBAC_LOGIN_EXPIRED');
    n = Number(await cdp.text('document.querySelectorAll(\'div.grid-table-row.student-grade\').length')) || 0;
    if (n > 0) break;
  }
  if (n > 0 && settleMs > 0) {
    for (let i = 0; i < 10; i++) {
      if ((await cdp.text('document.readyState')) === 'complete') break;
      await sleep(500);
    }
    await sleep(settleMs);
  }
  return n;
}

/**
 * 页面内：按行文本定位分数框，**只定位、不改值**，把目标 input 的 id 回报出来。
 *
 * 为什么不在这里直接写值（2026-09-16 实测教训）：
 *   成绩册是前端异步渲染的，分数框很可能是**受控组件**。直接 `el.value = x` 只改了 DOM 的
 *   显示值（所以当场回读能看到新值、容易误判成功），但框架内部状态没变，提交给服务端的仍是旧值
 *   ⇒ 表现为"点了写入、看着也写上了，ManageBac 里却没有"。正解是走**真实输入**
 *   （CDP 的 Input.insertText），让它像人打字一样触发框架的 input 事件。见调用处。
 */
function locateExpr(updates: { row: string; score?: string }[]): string {
  return `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const norm = (s) => clean(s).replace(/\\s+/g, '').toLowerCase();
  const updates = ${JSON.stringify(updates)};
  const rows = Array.from(document.querySelectorAll('div.grid-table-row.student-grade'));
  const out = [];
  for (const u of updates) {
    const k = norm(u.row);
    const target = rows.find((r) => {
      const c = r.querySelector(':scope > div.column');
      return c ? norm(c.textContent).includes(k) : false;
    });
    if (!target) { out.push({ row: u.row, ok: false, reason: '没找到该学生的行' }); continue; }
    const el = target.querySelector('input[name="core_task[grades][score]"]');
    if (!el) { out.push({ row: u.row, ok: false, reason: '该行没有分数框' }); continue; }
    if (!el.id) el.id = 'mbapi-' + Math.random().toString(36).slice(2, 9);
    out.push({
      row: u.row,
      score: u.score,
      ok: true,
      inputId: el.id,
      before: clean(String(el.value == null ? '' : el.value)),
    });
  }
  return JSON.stringify(out);
})()`;
}

/**
 * 通道 B（兜底，不依赖焦点与坐标）：用 `HTMLInputElement.prototype` 上的**原生 value setter** 赋值，
 * 再派发 `input`/`change`。React 的受控组件拦截的是 `el.value = x` 这种实例赋值，
 * **拦截不了原型上的原生 setter**；派发 `input` 后它的 onChange 必然收到 ——
 * 这是程序化驱动 React 表单的正规做法。返回写入后框里的值（'missing' = 元素不在）。
 */
function setViaNativeSetter(cdp: Cdp, inputId: string, text: string): Promise<string> {
  return cdp.text(`(() => {
    const el = document.getElementById(${JSON.stringify(inputId)});
    if (!el) return 'missing';
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!d || !d.set) return 'no-setter';
    d.set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return String(el.value == null ? '' : el.value);
  })()`);
}

/**
 * 「夺焦点」用的安全落点：**自己往页面角落塞一个 8×8 的透明块，点它自己的坐标**。
 *
 * 历史做法是在固定候选坐标里找一个 `elementFromPoint` 不是交互元素的"空白点"（连固定点 (4,4) 也用过）。
 * 两个问题：① 滚动位置不同，"空白点"落在哪里每次都不一样；② 那个点上可能是**带 click 处理的普通容器**
 * （如可排序表头、可点单元格）—— `closest('a,button,label,…')` 拦不住它，点下去会触发页面自己的逻辑，
 * 有可能把刚写完那一行的保存搅掉（**第一行尤其可疑**：它的滚动位置与后面几行不同，落点也就不同）。
 * 自己造的元素既不会被别的元素挡住（z-index 拉满），也绝不触发页面逻辑。
 */
async function focusStealTarget(cdp: Cdp): Promise<{ x: number; y: number }> {
  const raw = await cdp.text(`(() => {
    let el = document.getElementById('mbapi-focus-steal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mbapi-focus-steal';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:0;bottom:0;width:8px;height:8px;z-index:2147483647;background:transparent';
      (document.body || document.documentElement).appendChild(el);
    }
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  return raw ? (JSON.parse(raw) as { x: number; y: number }) : { x: 4, y: 4 };
}

/**
 * 把分数真正写进分数框 —— **两条独立通道一起走**，任一条成功即可。
 *
 * 为什么必须做到这个程度（2026-09-16 / 09-18 三次失败的教训）：
 *   ① `el.value = x`：只改 DOM 显示值，框架内部状态不变 ⇒ 当场回读看得到新值、实际没提交。
 *   ② `el.focus()` + `Input.insertText`：**仍然不可靠** —— JS 的 `focus()` 只改 DOM 焦点，
 *      CDP 输入层不一定认它；insertText 于是落空，而 `el.select()` 已全选
 *      ⇒ 教师看到的现象正是「写进去失败、再查又会变空」。
 *   ③ 改成真实鼠标点击后，实测活动元素是 `BODY#action-show` —— **点击坐标那点上根本没有输入框**
 *      （rect 看着合理，但 `elementFromPoint` 命中 body）。继续依赖坐标只会反复踩。
 *
 * 所以现在：
 *   **通道 A（主）**：`Input.dispatchMouseEvent` 真点一下 → 若命中输入框，再 `Ctrl+A` + `Backspace`
 *     + 逐字符 `keyDown/char/keyUp` —— 最贴近真人。
 *   **通道 B（兜底，不依赖焦点与坐标）**：见 `setViaNativeSetter`。
 *   **收尾**：无论走哪条，最后都要**真的把焦点移走**（点我们自己塞的透明块，见 focusStealTarget）
 *     —— ManageBac 是失焦保存型，值进了框架状态还不够，要真 blur 才会提交。
 *
 * 每一步都记进 `steps`（含 rect、命中元素、blur 次数、保存请求数），失败时能直接看出卡在哪一环。
 */
async function typeIntoScoreInput(
  cdp: Cdp,
  inputId: string,
  text: string,
): Promise<{ ok: boolean; steps: string[] }> {
  const idLit = JSON.stringify(inputId);
  const steps: string[] = [];
  const readVal = () =>
    cdp.text(`(() => { const el = document.getElementById(${idLit}); return el ? String(el.value == null ? '' : el.value) : '(元素消失)'; })()`);

  // 1) 几何诊断 + 真实鼠标点击。
  //    2026-09-18 实测：点击后活动元素是 `BODY#action-show` —— 坐标那点上根本没有输入框。
  //    所以这里把 rect、命中元素、可见性一起记下来，一眼能看出是「坐标算错」还是「框不可点」。
  const geoRaw = await cdp.text(`(() => {
    const el = document.getElementById(${idLit});
    if (!el) return '';
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const cs = getComputedStyle(el);
    return JSON.stringify({
      x: cx, y: cy,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','),
      hit: hit ? hit.tagName + '#' + (hit.id || '-') : 'none',
      style: cs.visibility + '/' + cs.display + '/pe=' + cs.pointerEvents,
    });
  })()`);
  if (!geoRaw) return { ok: false, steps: ['输入框已不在页面上'] };
  const geo = JSON.parse(geoRaw) as { x: number; y: number; rect: string; hit: string; style: string };
  steps.push(`框rect=[${geo.rect}] 该点命中=${geo.hit} 样式=${geo.style}`);

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
  const active = await cdp.text(
    `(() => { const a = document.activeElement; if (!a) return 'none'; return a.id === ${idLit} ? 'yes' : (a.tagName + '#' + (a.id || '-')); })()`,
  );
  steps.push(`点击(${geo.x},${geo.y})→活动元素=${active}`);

  // 2) **兜底通道**：用原生 value setter 写值（见 setViaNativeSetter）。
  //    它**不依赖焦点、也不依赖坐标** —— 即便上面点击没命中（活动元素是 BODY），值也能送进去。
  const nativeVal = await setViaNativeSetter(cdp, inputId, text);
  steps.push(`原生setter写入后='${nativeVal.trim()}'`);

  // 3) 若点击确实命中了输入框，再补一遍真实键盘输入（最贴近真人，兼容性最好）；
  //    没命中就跳过 —— 值已由第 2 步写入，不必强求。
  if (active === 'yes') {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    // 完整键盘序列：keyDown → char（带 text，负责插入）→ keyUp。
    // 之前只发 `char`，有些框架只监听 keydown/keyup，那样就完全收不到。
    for (const ch of text) {
      const isDigit = ch >= '0' && ch <= '9';
      const code = isDigit ? `Digit${ch}` : '';
      const vk = isDigit ? ch.charCodeAt(0) : 0;
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
    }
    const afterTyping = (await readVal()).trim();
    steps.push(`键盘键入后='${afterTyping}'`);
    // **绝不让它停在空值上**：键盘路径是「先 Ctrl+A+Backspace 清空、再逐字符键入」，
    // 一旦键入落空，框里就剩个空值 —— 而失焦会把这个空值当"改成空"提交上去
    // （2026-09-21 教师报的「十几个一起填，有几个读回是空值」正是它）。
    // 所以键盘路径没写对就用原生 setter 补回目标值。
    if (afterTyping !== text.trim()) {
      const fixed = (await setViaNativeSetter(cdp, inputId, text)).trim();
      steps.push(`键盘路径没写对，改走原生setter后='${fixed}'`);
    }
  }

  // 4) **失焦提交**。
  //
  // 2026-09-18 关键修正：教师确认「失焦即保存」是对的（手动填与油猴脚本都如此）。
  // 那之前的失败就出在「我们的失焦根本没发生」上 ——
  // `Input.dispatchKeyEvent` 发 Tab 只是把按键投递给页面，**不保证执行「移动焦点」这个默认行为**，
  // 焦点没移走 ⇒ 没有 blur ⇒ 框架的保存 handler 不会被调用（网络抓包也证实 0 条保存请求）。
  //
  // 所以改为**真实点击页面空白处**夺走焦点（真焦点转移 ⇒ 真 blur），
  // 并且**挂一个计数器验证 blur 确实发生** —— 之前那句"Tab 失焦后=xx"只是又读了遍值，
  // 根本证明不了失焦，这是排查一直打转的原因之一。
  await cdp.text(
    `(() => { window.__mbBlur = 0; const el = document.getElementById(${idLit}); `
    + `if (el) el.addEventListener('blur', () => { window.__mbBlur++; }, true); return 'ok'; })()`,
  );
  // 点我们自己塞的透明块夺焦（见 focusStealTarget：不再赌"页面空白处"上是什么元素）
  const spot = await focusStealTarget(cdp);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
  const blurCount = await cdp.text('String(window.__mbBlur)');
  const activeAfter = await cdp.text(
    `(() => { const a = document.activeElement; return a ? (a.tagName + '#' + (a.id || '-')) : 'none'; })()`,
  );
  const finalVal = (await readVal()).trim();
  steps.push(`点自建透明块(${spot.x},${spot.y})夺焦：blur次数=${blurCount} 活动元素=${activeAfter} 值='${finalVal}'`);

  return { ok: finalVal === text.trim() && blurCount !== '0', steps };
}

/** 打开某个 task 的成绩册页并读回所有学生行（**只读**）。
 *  term 路径不自己拼：先到「全部任务」列表，按 taskId 找到页面给出的链接再进 —— term 变了也不用改代码。 */
async function openTaskGradebook(
  cdp: Cdp,
  mbClassId: string,
  taskId: string,
): Promise<{
  url: string;
  title: string;
  count: number;
  rows: { name: string; alt: string; score: string; scoreBox: boolean }[];
}> {
  await navigateToTask(cdp, mbClassId, taskId);
  if (!(await waitStudentRows(cdp))) {
    throw new Error('没读到学生行（该 task 可能还没有学生，或页面结构有变）');
  }

  return JSON.parse(await cdp.text(MARKS_EXPR)) as {
    url: string;
    title: string;
    count: number;
    rows: { name: string; alt: string; score: string; scoreBox: boolean }[];
  };
}

/** 错误映射：登录过期单独给出可操作的提示；其余按动作归类（读取/写入） */
function marksError(e: unknown, t0: number, action = '读取'): Response {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === 'MANAGEBAC_LOGIN_EXPIRED') {
    return json(409, {
      error: 'ManageBac 登录态已过期',
      hint: '在 app/ 下跑 node scripts/mb-login-local.mjs 重新登录一次（不消耗浏览器额度），再回来重试。',
      elapsedMs: Date.now() - t0,
    });
  }
  return json(502, { error: `${action}失败`, hint: msg.slice(0, 400), detail: msg.slice(0, 400), elapsedMs: Date.now() - t0 });
}
