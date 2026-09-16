#!/usr/bin/env node
/**
 * ManageBac 成绩册 · 任务列表抓取 + 短码匹配（Browser Run + 已有 cookie，无需再次登录）
 * ============================================================================
 * 这是「线上自动同步」第四步的原型（只读）：
 *   打开某班的成绩册「全部任务」视图 → 抓出每个 task 的名字与 core_tasks/<id>
 *   → 若给了 --code，则按 [短码] **精确匹配**（0 个 / 多个都算未命中，绝不猜）。
 *
 * 用法：
 *   node scripts/mb-tasks.mjs --class 11420931                     # 只看列表
 *   node scripts/mb-tasks.mjs --class 11420931 --code A2-0915      # 顺带做短码匹配
 *   node scripts/mb-tasks.mjs --url "https://…/gradebook/core_tasks" --code A2-0915
 *
 * 说明：
 *   · --class 就是成绩册 URL 里 /teacher/classes/<id>/ 那段（「班级管理」页有回显）
 *   · task 名是教师自己起的，不含学生信息；本脚本**不读取、不输出任何学生姓名与分数**
 *   · 会话一定显式关闭（官方 FAQ：不关会话会一直烧浏览器额度）
 *
 * 前提：已跑过 `cf-managebac-login.mjs`，`_ocrlab_out/mb-cookies.json` 仍在有效期内。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.cwd());
const DEV_VARS = path.join(ROOT, '.dev.vars');
const OUT_DIR = path.join(ROOT, '_ocrlab_out');
const COOKIE_FILE = path.join(OUT_DIR, 'mb-cookies.json');

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

function devVar(name) {
  if (!existsSync(DEV_VARS)) return '';
  for (const line of readFileSync(DEV_VARS, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const HOST = argOf('--host', 'dtd.managebac.cn');
const CLASS_ID = argOf('--class', '');
const CODE = argOf('--code', '');
const TASK_ID = argOf('--task', ''); // 有值时进入「读成绩册行」模式
const TARGET = argOf('--url', CLASS_ID ? `https://${HOST}/teacher/classes/${CLASS_ID}/gradebook/core_tasks` : '');

if (!TARGET) {
  console.log('缺少目标：用 --class <ManageBac班级号>（或直接给 --url）');
  console.log('例：node scripts/mb-tasks.mjs --class 11420931 --code A2-0915');
  process.exit(2);
}
if (!existsSync(COOKIE_FILE)) {
  console.log('缺少 cookie：先跑 node scripts/cf-managebac-login.mjs（并完成手动登录）');
  process.exit(2);
}
const cookies = JSON.parse(readFileSync(COOKIE_FILE, 'utf-8'));

const accountId = devVar('CF_ACCOUNT_ID');
const token = devVar('CF_API_TOKEN');
if (!accountId || !token) {
  console.log('缺少 CF 凭据：在 app/.dev.vars 里补 CF_ACCOUNT_ID / CF_API_TOKEN');
  process.exit(2);
}
const BASE = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering`;
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** 带退避：免费版有"1 个新实例/20 秒""10 分钟/天"限制，超限返回 429（可能带 Retry-After） */
async function cfFetch(url, init = {}, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    const r = await fetch(url, init);
    if (r.status !== 429 && r.status < 500) return r;
    const ra = Number(r.headers.get('retry-after') || 0);
    const wait = (ra > 0 ? ra : 25) * 1000;
    log(`  ⏳ 被限流/服务端错误（HTTP ${r.status}），${Math.round(wait / 1000)} 秒后重试（${i}/${tries}）…`);
    if (i === tries) return r;
    await sleep(wait);
  }
  return fetch(url, init);
}

/**
 * 页面内提取成绩册行（`--task` 模式）：
 * 把每行的完整线索都取回来 —— title 全文、链接文本、各列文本、分数框当前值。
 * 用途：确认成绩册上究竟用什么标识（学号？姓名？），从而决定名单桥接该用哪个字段。
 * 只读：不读取、不输出任何分数以外的个人信息；分数仅用于确认位置。
 */
const MARKS_EXPR = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const rows = [];
  for (const r of document.querySelectorAll('div.grid-table-row.student-grade')) {
    const cols = r.querySelectorAll(':scope > div.column');
    const nameCol = cols[0] || null;
    const a = nameCol ? nameCol.querySelector('a') : null;
    const sc = r.querySelector('input[name="core_task[grades][score]"]');
    rows.push({
      title: a ? (a.getAttribute('title') || '') : '',
      href: a ? (a.getAttribute('href') || '') : '',
      linkText: a ? clean(a.textContent) : '',
      colText: clean(nameCol ? nameCol.textContent : ''),
      colCount: cols.length,
      score: sc ? clean(String(sc.value || '')) : '',
    });
  }
  return JSON.stringify({ url: location.href, title: document.title, count: rows.length, rows }, null, 2);
})()`;

/** 页面内提取：task 名 + core_tasks/<id>、term 下拉、表格是否横向滚动 */
const TASKS_EXPR = `(() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="core_tasks/"]')) {
    const m = /core_tasks\\/(\\d+)/.exec(a.getAttribute('href') || '');
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90) });
  }
  // 网格表头（div 结构，不是 thead）：取第一行各列文本，便于核对列名结构
  const headerRow = document.querySelector('.grid-table-row:not(.student-grade), .grid-table-header, .grid-table thead tr');
  const headerCells = headerRow
    ? Array.from(headerRow.children).slice(0, 40).map((c) => (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60))
    : [];
  const grid = document.querySelector('.grid-table');
  const selects = Array.from(document.querySelectorAll('select')).map((s) => ({
    cls: String(s.className || '').slice(0, 40),
    value: s.value,
    options: Array.from(s.options).map((o) => (o.textContent || '').trim().slice(0, 30)).slice(0, 15),
  })).filter((s) => s.options.length > 1);
  return JSON.stringify({
    url: location.href,
    title: document.title,
    taskCount: out.length,
    tasks: out,
    headerCells,
    gridScroll: grid ? { clientWidth: grid.clientWidth, scrollWidth: grid.scrollWidth } : null,
    selects: selects.slice(0, 4),
  }, null, 2);
})()`;

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
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Network.enable');
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
    if (r.exceptionDetails) {
      const d =
        r.exceptionDetails.exception?.description ??
        r.exceptionDetails.exception?.value ??
        r.exceptionDetails.text ??
        '页面脚本执行失败';
      throw new Error(String(d).slice(0, 400));
    }
    return r.result?.value;
  }
}

let sessionId = '';
async function closeSession() {
  if (!sessionId) return;
  try {
    await fetch(`${BASE}/devtools/browser/${sessionId}`, { method: 'DELETE', headers: H });
    log('[cleanup] 会话已关闭');
  } catch {
    /* 忽略 */
  }
}

/** 与 src/lib/mbSync.ts 的 shortCodePattern 保持同一口径：方括号 + 精确短码，忽略大小写 */
function shortCodeRe(code) {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[\\s*${esc}\\s*\\]`, 'i');
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const cr = await cfFetch(`${BASE}/devtools/browser?keep_alive=300000`, { method: 'POST', headers: H });
  const cj = await cr.json();
  if (!cr.ok || !cj?.sessionId) {
    log(`创建会话失败：${JSON.stringify(cj).slice(0, 200)}`);
    process.exit(1);
  }
  sessionId = cj.sessionId;
  log(`会话 ${sessionId}（注入 ${cookies.length} 条 cookie）`);

  const nr = await cfFetch(`${BASE}/devtools/browser/${sessionId}/json/new?url=about:blank`, { method: 'PUT', headers: H });
  const nj = await nr.json();
  if (!nr.ok || !nj.webSocketDebuggerUrl) {
    log(`标签页失败：${JSON.stringify(nj).slice(0, 200)}`);
    await closeSession();
    process.exit(1);
  }
  const cdp = await Cdp.connect(nj.webSocketDebuggerUrl);

  const host = new URL(TARGET).hostname;
  const usable = cookies.filter(
    (c) => String(c.domain || '').replace(/^\./, '').endsWith(host.replace(/^[^.]+\./, '')) || String(c.domain || '').includes(host),
  );
  await cdp.send('Network.setCookies', {
    cookies: (usable.length ? usable : cookies).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    })),
  });
  log(`已注入 ${(usable.length ? usable : cookies).length} 条 cookie → 打开 ${TARGET}`);

  await cdp.send('Page.navigate', { url: TARGET });

  // 任务列是前端异步渲染的：轮询等待出现 core_tasks 链接（最多 60 秒）
  // 同时**先看是否落在登录页**：cookie 过期时立即退出。
  // （2026-09-16 实测：原来的写法会白等满 60 秒才发现是登录页，白烧掉一天额度的 10%）
  let ready = 0;
  let landedLogin = '';
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const href = String((await cdp.eval('location.href')) ?? '');
      if (/\/login/i.test(href)) {
        landedLogin = href;
        break;
      }
      ready = Number(await cdp.eval('document.querySelectorAll(\'a[href*="core_tasks/"]\').length')) || 0;
    } catch {
      ready = 0;
    }
    if (i % 3 === 0) log(`  …等待任务列表渲染（core_tasks 链接 ${ready} 个）`);
    if (ready > 0) break;
  }

  if (landedLogin) {
    log(`⚠️ 落到了登录页（cookie 已过期）：${landedLogin}`);
    log('   解决：在 app/ 下跑 node scripts/mb-login-local.mjs（本机 Chrome 登录，不消耗浏览器额度），');
    log('         cookie 会写回 _ocrlab_out/mb-cookies.json，再回来跑本脚本。');
    await closeSession();
    process.exit(3);
  }

  // ---- --task 模式：读该 task 的成绩册行（只读）----
  if (TASK_ID) {
    const href = await cdp.eval(
      `(() => { const a = document.querySelector('a[href*="core_tasks/${TASK_ID}"]'); return a ? a.href : ''; })()`,
    );
    if (!href) {
      log(`没在列表里找到 task ${TASK_ID} 的链接（它可能属于另一个 term）`);
      await closeSession();
      process.exit(1);
    }
    log(`进入成绩册：${href}`);
    await cdp.send('Page.navigate', { url: href });

    let rows = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const h = String(await cdp.eval('location.href'));
      if (/\/login/i.test(h)) {
        log('⚠ 又落回登录页（cookie 过期）');
        await closeSession();
        process.exit(3);
      }
      rows = Number(await cdp.eval('document.querySelectorAll(\'div.grid-table-row.student-grade\').length')) || 0;
      if (i % 3 === 0) log(`  …等待学生行（当前 ${rows} 行）`);
      if (rows > 0) break;
    }
    if (!rows) {
      log('没读到学生行');
      await closeSession();
      process.exit(1);
    }

    const info = JSON.parse(await cdp.eval(MARKS_EXPR));
    const file = path.join(OUT_DIR, `mb-marks-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    writeFileSync(file, JSON.stringify(info, null, 2), 'utf-8');

    log(`\n== 成绩册行（${info.count} 行）==`);
    for (const r of info.rows) {
      log(`  title = [${r.title}]`);
      log(`    链接文本=[${r.linkText}]  列文本=[${r.colText}]  分数=[${r.score}]`);
    }
    log(`\n→ 结构化结果：${path.relative(ROOT, file)}`);
    await closeSession();
    process.exit(0);
  }

  const raw = await cdp.eval(TASKS_EXPR);
  const info = JSON.parse(raw);
  const file = path.join(OUT_DIR, `mb-tasks-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(file, JSON.stringify(info, null, 2), 'utf-8');

  log(`\n== 页面 ==\n${info.title}\n${info.url}`);
  log(`\n== 任务（${info.taskCount} 个）==`);
  for (const t of info.tasks.slice(0, 40)) log(`  ${t.id}  ${t.name}`);
  if (info.taskCount > 40) log(`  …（还有 ${info.taskCount - 40} 个，见 JSON）`);

  if (info.headerCells?.length) {
    log('\n== 表头各列（前 6 列）==');
    log('  ' + info.headerCells.slice(0, 6).map((h) => h || '(空)').join(' | '));
  }
  if (info.gridScroll) {
    log(`\n== 横向滚动 ==\n  可见宽 ${info.gridScroll.clientWidth} / 内容宽 ${info.gridScroll.scrollWidth}` +
      (info.gridScroll.scrollWidth > info.gridScroll.clientWidth ? '（有横向滚动 ✓ DOM 里列已全部渲染）' : '（无需滚动）'));
  }
  for (const s of info.selects ?? []) {
    log(`\n== 下拉（class=${s.cls}，当前值=${s.value || '(空)'}）==\n  ${s.options.join(' | ')}`);
  }

  if (CODE) {
    const re = shortCodeRe(CODE);
    const matches = info.tasks.filter((t) => re.test(t.name));
    log(`\n== 短码匹配 ==\n短码 [${CODE}] → ${matches.length} 条命中`);
    if (matches.length === 1) {
      log(`  ✔ 唯一命中：${matches[0].id}  ${matches[0].name}`);
      log('  （下一步就可以把它写进 mb_task_links 完成绑定）');
    } else if (matches.length === 0) {
      log(`  ✗ 未找到含 [${CODE}] 的 task（共 ${info.taskCount} 个）`);
      log('    · 检查 ManageBac 里该 task 名是否粘了这个短码（含方括号）');
      log('    · 也可能它不在当前 term 视图里 —— 看上面的下拉选项');
    } else {
      log('  ✗ 多条命中，按约定**不猜**：');
      for (const m of matches) log(`      ${m.id}  ${m.name}`);
    }
  }

  log(`\n→ 结构化结果已写入 ${path.relative(ROOT, file)}`);
  await closeSession();
  process.exit(0);
}

process.on('SIGINT', async () => {
  await closeSession();
  process.exit(1);
});
main().catch(async (e) => {
  console.error('失败：' + (e instanceof Error ? e.message : String(e)));
  await closeSession();
  process.exit(1);
});
