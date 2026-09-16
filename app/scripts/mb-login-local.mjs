#!/usr/bin/env node
/**
 * 本机 Chrome 登录 ManageBac → 抓 cookie → 写入 _ocrlab_out/mb-cookies.json
 * ======================================================================
 * 为什么要有它（对比 cf-managebac-login.mjs）：
 *   · CF 版靠 live-view 把远端浏览器画面投屏到本机 → 远端机房距离远，键鼠往返延迟高，
 *     登录时明显发飘；而且登录过程**消耗 Cloudflare 浏览器额度**（10 分钟/天）。
 *   · 本脚本改用**你本机已装的 Chrome**：正常速度、不投屏、**不消耗任何 CF 额度**，
 *     并且给它一个**独立且持久**的 profile（放在 %LOCALAPPDATA%，避免 OneDrive 同步干扰）
 *     ⇒ 只要 profile 里的登录态没过期，**下次可能连登录都不用做**。
 *
 * 输出格式与 CF 版完全一致（同为 cookie 数组，字段 name/value/domain/path/secure/httpOnly），
 * 因此 `mb-tasks.mjs` / `mb-explore.mjs` 等脚本无需任何改动。
 *
 * 用法：
 *   node scripts/mb-login-local.mjs            # 启动 Chrome，你登录后自动抓取并保存
 *   node scripts/mb-login-local.mjs --now      # 不等跳转信号，立刻抓一次（已登录时用）
 *   node scripts/mb-login-local.mjs --check    # 只看现有 cookie 文件状态
 *   node scripts/mb-login-local.mjs --chrome "D:\\path\\to\\chrome.exe"
 *
 * 抓完后可以关掉那个 Chrome 窗口（profile 会保留，下次免登录）。
 * 本脚本**不打印任何 cookie 值**，只打印条数与名字。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.cwd());
const OUT_DIR = path.join(ROOT, '_ocrlab_out');
const COOKIE_FILE = path.join(OUT_DIR, 'mb-cookies.json');

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = Number(argOf('--port', '9333'));
const MB_HOST = argOf('--host', 'dtd.managebac.cn');
const START_URL = argOf('--url', `https://${MB_HOST}/`);
const GRAB_NOW = args.includes('--now');
const CHECK_ONLY = args.includes('--check');
const PUSH_ONLY = args.includes('--push-only'); // 不启动浏览器，只把现有 cookie 同步到云端
const NO_PUSH = args.includes('--no-push');     // 抓完不同步到云端（只更新本机文件）
const TEACHER_ID = argOf('--teacher', '');      // 教师 user id；留空则自动从 teacher_roles 取

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookieStatus() {
  if (!existsSync(COOKIE_FILE)) {
    log('cookie 文件：不存在（尚未成功抓取过）');
    return 0;
  }
  const st = statSync(COOKIE_FILE);
  let n = 0;
  try {
    n = (JSON.parse(readFileSync(COOKIE_FILE, 'utf-8')) || []).length;
  } catch {
    n = -1;
  }
  log(`cookie 文件：${path.relative(ROOT, COOKIE_FILE)}`);
  log(`  采集时间：${st.mtime.toLocaleString()}  条数：${n}${n < 0 ? '（解析失败，建议重抓）' : ''}`);
  return n;
}

if (CHECK_ONLY) {
  cookieStatus();
  process.exit(0);
}

if (PUSH_ONLY) {
  const n = cookieStatus();
  if (n <= 0) {
    log('没有可用的 cookie 文件 —— 先正常跑一次本脚本完成登录。');
    process.exit(2);
  }
  const ok = await pushToCloud(JSON.parse(readFileSync(COOKIE_FILE, 'utf-8')));
  process.exit(ok ? 0 : 1);
}

// ---- 找本机浏览器（Chrome 优先，其次 Edge；可用 --chrome 指定）----
const LOCAL = process.env.LOCALAPPDATA || '';
const CANDIDATES = [
  argOf('--chrome', ''),
  LOCAL && path.join(LOCAL, 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  LOCAL && path.join(LOCAL, 'Microsoft/Edge/Application/msedge.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const EXE = CANDIDATES.find((p) => existsSync(p));
if (!EXE) {
  log('没找到本机 Chrome/Edge。请用 --chrome "<可执行文件路径>" 指定。');
  process.exit(2);
}

// profile 放 %LOCALAPPDATA%（不放工作区：OneDrive 同步会干扰 Chrome 的 profile 文件锁）
const PROFILE = path.join(LOCAL || process.env.TEMP || '.', 'mb-login-profile');
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

log(`浏览器：${EXE}`);
log(`独立 profile：${PROFILE}`);
log('（注意：Chrome 自 136 起，只允许"非默认 profile"开启调试端口 —— 所以必须用独立 profile）');

const child = spawn(
  EXE,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    START_URL,
  ],
  { detached: true, stdio: 'ignore' },
);
child.unref();

// ---- 等调试端口起来 ----
let version = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) {
      version = await r.json();
      break;
    }
  } catch {
    /* 还没起来 */
  }
  if (i % 5 === 4) log('  …等待浏览器调试端口就绪');
}
if (!version) {
  log(`调试端口 ${PORT} 未就绪。可能 Chrome 已在用该端口（先关掉它）或用的是默认 profile。`);
  process.exit(1);
}
log(`已连接：${version.Browser}`);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!m.id) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    const c = new Cdp(ws);
    await c.send('Runtime.enable');
    return c;
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本执行失败');
    return r.result?.value;
  }
}

/** 在 /json/list 里找 ManageBac 那个标签页；没有就新开一个 */
async function findMbTarget() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await r.json();
  const page = (list || []).find((t) => t.type === 'page' && String(t.url || '').includes(MB_HOST));
  if (page) return page;
  const nr = await fetch(`http://127.0.0.1:${PORT}/json/new?url=${encodeURIComponent(START_URL)}`, { method: 'PUT' });
  return nr.json();
}

const target = await findMbTarget();
if (!target?.webSocketDebuggerUrl) {
  log('没找到 ManageBac 标签页，也没能新开一个。');
  process.exit(1);
}
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

// ---- 等登录完成：URL 离开 /login 且进入 /teacher/ ----
if (!GRAB_NOW) {
  log(`\n👉 请在弹出的浏览器窗口里登录 ManageBac（本机直连，不会卡）。`);
  log('   登录成功后本脚本会自动检测并抓取 cookie，无需你点任何东西。\n');
  let done = false;
  for (let i = 0; i < 300; i++) {
    await sleep(2000);
    let href = '';
    try {
      href = String(await cdp.eval('location.href'));
    } catch {
      href = '';
    }
    if (/\/teacher\//i.test(href)) {
      done = true;
      break;
    }
    if (i % 5 === 4) log(`  …等待登录（当前页面：${href.replace(/[?].*$/, '').slice(0, 80) || '读取中'}）`);
  }
  if (!done) {
    log('\n⏱ 等待超时（10 分钟）。若你其实已登录，可用 `--now` 直接抓一次。');
  }
}

// ---- 抓 cookie（浏览器级，不用先 enable Network）----
const res = await cdp.send('Storage.getCookies', {});
const cookies = (res.cookies || [])
  .filter((c) => String(c.domain || '').includes('managebac'))
  .map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    expires: c.expires ?? -1,
  }));

if (cookies.length === 0) {
  log('\n没抓到任何 managebac 域的 cookie —— 说明还没登录成功。');
  log('请在那个 Chrome 窗口里完成登录（浏览器保持开着），然后重跑：node scripts/mb-login-local.mjs --now');
  process.exit(3);
}

writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf-8');
log(`\n✔ 已写入 ${cookies.length} 条 cookie → ${path.relative(ROOT, COOKIE_FILE)}`);
log(`  cookie 名（只列名字，不打印值）：${cookies.map((c) => c.name).slice(0, 10).join(', ')}`);
log('\n接下来：');
log('  1) 可以关掉那个 Chrome 窗口了（profile 保留，下次通常免登录）');
log('  2) 抓任务列表：node scripts/mb-tasks.mjs --class 11420931');
log('  3) 本脚本不消耗任何 Cloudflare 浏览器额度');

if (!NO_PUSH) await pushToCloud(cookies);

// ---- 同步到云端（2026-09-16 方案 (a)）----
// 线上 Worker 在 Cloudflare 云端**没有 ManageBac 登录态**，打不开成绩册。
// 所以把本机登录得到的 cookie 同步一份到 Supabase 的 mb_sessions（RLS 仅教师本人可读），
// Worker 用**请求自带的教师 JWT**读出后注入浏览器，只做只读抓取。
// 这里走本机 psql 直连（凭 %USERPROFILE%\.pgpass），SQL 经 stdin 传入，不落临时文件。
function pgConn() {
  const pgpass = path.join(process.env.USERPROFILE || '', '.pgpass');
  if (!existsSync(pgpass)) return null;
  const line = readFileSync(pgpass, 'utf-8')
    .split(/\r?\n/)
    .find((l) => l.trim() && !l.trim().startsWith('#'));
  if (!line) return null;
  const [host, port, db, user] = line.split(':');
  if (!host || !user) return null;
  return { conn: `postgresql://${user}@${host}:${port}/${db}`, pgpass };
}

function psqlRun(pg, sql) {
  const r = spawnSync('psql', [pg.conn, '-w', '-v', 'ON_ERROR_STOP=1', '-At', '-f', '-'], {
    input: sql,
    encoding: 'utf-8',
    env: { ...process.env, PGPASSFILE: pg.pgpass },
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

async function pushToCloud(cookies) {
  const pg = pgConn();
  if (!pg) {
    log('\n⚠ 没找到 %USERPROFILE%\\.pgpass，跳过云端同步 —— 线上「绑定」会因缺少登录态而不可用。');
    return false;
  }
  let teacherId = TEACHER_ID;
  if (!teacherId) {
    const q = psqlRun(pg, 'select user_id from public.teacher_roles');
    if (!q.ok) {
      log('\n⚠ 读取 teacher_roles 失败：' + (q.err || q.out));
      return false;
    }
    const ids = q.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (ids.length !== 1) {
      log(`\n⚠ teacher_roles 里有 ${ids.length} 个教师，请用 --teacher <user_id> 指定。`);
      return false;
    }
    teacherId = ids[0];
  }
  const sql =
    'insert into public.mb_sessions (teacher_id, cookies, domain, captured_at, updated_at)\n' +
    `values ('${teacherId.replace(/'/g, "''")}', $mbc$${JSON.stringify(cookies)}$mbc$::jsonb, '${MB_HOST}', now(), now())\n` +
    'on conflict (teacher_id) do update\n' +
    '  set cookies = excluded.cookies, domain = excluded.domain, captured_at = excluded.captured_at, updated_at = now();\n';
  const r = psqlRun(pg, sql);
  if (!r.ok) {
    log('\n⚠ 云端同步失败：' + (r.err || r.out || '未知错误'));
    return false;
  }
  log(`\n✔ 已同步到云端 mb_sessions（教师 ${teacherId.slice(0, 8)}…，${cookies.length} 条 cookie，目标域 ${MB_HOST}）`);
  log('  线上「绑定」即可用它抓取；写入方始终是本机脚本，Worker 只读。');
  return true;
}
