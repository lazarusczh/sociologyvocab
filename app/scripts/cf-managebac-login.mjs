#!/usr/bin/env node
/**
 * ManageBac 登录 + 结构勘探（Cloudflare Browser Run，REST + CDP）
 * =================================================================
 * 流程：
 *   ① 在 Cloudflare 云端开一个浏览器会话 → 打开 ManageBac 登录页
 *   ② 打印 **Live View 链接**（官方 devtoolsFrontendUrl，在你的 Chrome 里打开即可看到并操作那个云端浏览器）
 *   ③ **你在 Live View 里手动登录**（含 2FA 都行）—— 本脚本不接触、不保存你的账号密码 ✓
 *   ④ 脚本自动检测到"已离开登录页"后 → dump 当前页面结构 + **导出 cookie**（存到 gitignore 的目录）
 *   ⑤ 之后进入交互：你可以在 Live View 里点进成绩册，回到终端敲 dump 再抓一次
 *
 * 产出（均在 app/_ocrlab_out/，已 gitignore）：
 *   mb-dump-<时间>.json      页面结构（输入框/按钮/链接/表格；只记 filled 布尔，不记输入值）
 *   mb-shot-<时间>.png       截图
 *   mb-cookies.json          cookies（**只打印数量与域名，绝不打印值**）
 *
 * 用法：
 *   node scripts/cf-managebac-login.mjs
 *   node scripts/cf-managebac-login.mjs --url https://dtd.managebac.cn/login
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const ROOT = path.resolve(process.cwd());
const DEV_VARS = path.join(ROOT, '.dev.vars');
const OUT_DIR = path.join(ROOT, '_ocrlab_out');

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const LOGIN_URL = argOf('--url', 'https://dtd.managebac.cn/login');
const KEEP_ALIVE = Number(argOf('--keep', '600000')); // 10 分钟（官方上限）
// --smoke：跳过"等登录"与交互环节，只验证 REST+CDP 管线本身（自检用，日常不用）
const SMOKE = args.includes('--smoke');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function devVar(name) {
  if (!existsSync(DEV_VARS)) return '';
  for (const line of readFileSync(DEV_VARS, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const accountId = devVar('CF_ACCOUNT_ID');
const token = devVar('CF_API_TOKEN');
if (!accountId || !token) {
  log('缺少凭据：请在 app/.dev.vars 里补 CF_ACCOUNT_ID 与 CF_API_TOKEN');
  process.exit(2);
}
const BASE = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering`;
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const DUMP_EXPR = `(() => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const txt = (e) => ((e && e.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const at = (e, names) => Object.fromEntries(names.map((n) => [n, e.getAttribute(n)]).filter(([, v]) => v));
  return JSON.stringify({
    url: location.href,
    title: document.title,
    headings: q('h1,h2,h3').map(txt).filter(Boolean).slice(0, 30),
    inputs: q('input,textarea,select').map((e) => ({
      tag: e.tagName.toLowerCase(), ...at(e, ['type', 'name', 'id', 'placeholder', 'aria-label']),
      filled: !!(e.value || '').length,
    })).slice(0, 60),
    buttons: q('button,[role=button],input[type=submit]').map((e) => ({ text: txt(e), ...at(e, ['id', 'class']) })).slice(0, 60),
    links: q('a[href]').map((e) => ({ t: txt(e), h: e.getAttribute('href') })).filter((x) => x.t).slice(0, 80),
    tables: q('table').slice(0, 4).map((t) => ({
      headers: Array.from(t.querySelectorAll('thead th, tr:first-child th, tr:first-child td')).map(txt).filter(Boolean).slice(0, 25),
      firstRows: Array.from(t.querySelectorAll('tbody tr, tr')).slice(0, 4).map((r) => Array.from(r.children).map(txt).slice(0, 25)),
    })),
    counts: { inputs: q('input,textarea,select').length, buttons: q('button,[role=button]').length, tables: q('table').length },
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
      const p = m.id && this.pending.get(m.id);
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面脚本执行失败');
    return r.result?.value;
  }
}

let sessionId = '';
async function closeSession() {
  if (!sessionId) return;
  try {
    const r = await fetch(`${BASE}/devtools/browser/${sessionId}`, { method: 'DELETE', headers: H });
    log(`[cleanup] DELETE session → HTTP ${r.status}`);
  } catch {
    /* 忽略 */
  }
}

async function dumpAndShot(cdp, tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dump = JSON.parse(await cdp.eval(DUMP_EXPR));
  const dumpFile = path.join(OUT_DIR, `mb-dump-${stamp}.json`);
  writeFileSync(dumpFile, JSON.stringify(dump, null, 2), 'utf-8');
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  const shotFile = path.join(OUT_DIR, `mb-shot-${stamp}.png`);
  writeFileSync(shotFile, Buffer.from(shot, 'base64'));

  log(`\n[dump:${tag}] ${dump.title || '(无标题)'}`);
  log(`        ${dump.url}`);
  log(`        输入框 ${dump.counts.inputs} · 按钮 ${dump.counts.buttons} · 表格 ${dump.counts.tables}`);
  if (dump.headings.length) log(`        标题：${dump.headings.slice(0, 6).join(' | ')}`);
  if (dump.tables.length) log(`        表头：${dump.tables.map((t) => t.headers.slice(0, 6).join(',')).join(' || ')}`);
  log(`        → ${path.relative(ROOT, dumpFile)}`);
  log(`        → ${path.relative(ROOT, shotFile)}`);
  return dump;
}

async function exportCookies(cdp) {
  const r = await cdp.send('Network.getAllCookies');
  const cookies = r?.cookies ?? [];
  const file = path.join(OUT_DIR, 'mb-cookies.json');
  writeFileSync(file, JSON.stringify(cookies, null, 2), 'utf-8');
  const domains = [...new Set(cookies.map((c) => c.domain))];
  log(`\n[cookies] 共 ${cookies.length} 条，域名：${domains.join(', ')}`);
  log(`          → ${path.relative(ROOT, file)}（**只打印数量与域名，不打印值**）`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  log(`创建云端浏览器会话（keep_alive=${KEEP_ALIVE}ms = ${KEEP_ALIVE / 60000} 分钟）…`);
  const cr = await fetch(`${BASE}/devtools/browser?keep_alive=${KEEP_ALIVE}`, { method: 'POST', headers: H });
  const cj = await cr.json();
  if (!cr.ok || !cj?.sessionId) {
    log(`创建会话失败 HTTP ${cr.status}：${JSON.stringify(cj).slice(0, 300)}`);
    process.exit(1);
  }
  sessionId = cj.sessionId;
  log(`会话就绪：${sessionId}`);

  log(`打开登录页：${LOGIN_URL}`);
  const nr = await fetch(`${BASE}/devtools/browser/${sessionId}/json/new?url=${encodeURIComponent(LOGIN_URL)}`, {
    method: 'PUT',
    headers: H,
  });
  const nj = await nr.json();
  if (!nr.ok || !nj.webSocketDebuggerUrl) {
    log(`新建标签页失败 HTTP ${nr.status}：${JSON.stringify(nj).slice(0, 300)}`);
    await closeSession();
    process.exit(1);
  }

  log('\n================ 请在下面这个链接里手动登录 ================');
  log(nj.devtoolsFrontendUrl || '(未返回 devtoolsFrontendUrl)');
  log('（在 Chrome 打开它 = 直接操作云端那个浏览器；本脚本不接触你的账号密码）');
  log('⚠ 该链接自生成起约 5 分钟有效；过期了就重跑本脚本');
  log('==========================================================\n');

  const cdp = await Cdp.connect(nj.webSocketDebuggerUrl);

  if (SMOKE) {
    await sleep(2500);
    await dumpAndShot(cdp, 'smoke');
    await exportCookies(cdp);
    await closeSession();
    log('\n[smoke] 管线自检通过（未涉及登录）');
    process.exit(0);
  }

  // 等登录完成：URL 离开 /login 即认为已进站（登录页通常带 password 输入框）
  const t0 = Date.now();
  let loggedIn = false;
  for (let i = 0; i < 120; i++) {
    await sleep(4000);
    let href = '';
    let hasPwd = true;
    try {
      href = (await cdp.eval('location.href')) || '';
      hasPwd = await cdp.eval("!!document.querySelector('input[type=password]')");
    } catch {
      /* 页面切换中 */
    }
    if (i % 3 === 0) log(`  …等待登录（当前 ${href.slice(0, 80) || '加载中'}）`);
    if (href && !/\/login/i.test(href) && !hasPwd) {
      loggedIn = true;
      log(`\n检测到登录完成：${href}`);
      break;
    }
    if (Date.now() - t0 > 9 * 60 * 1000) break;
  }

  if (loggedIn) {
    await dumpAndShot(cdp, '登录后');
    await exportCookies(cdp);
  } else {
    log('\n未检测到登录完成（可能还在登录页或已超时）——你仍可在终端用 dump 手动抓取。');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  log('\n可用命令：dump（抓当前页）| shot（截图）| cookies（导出）| quit');
  log('提示：在 Live View 里点进「某个班的成绩册」，然后回终端敲 dump —— 我要的就是那个结构。\n');
  for (;;) {
    const line = (await ask('mb> ')).trim();
    if (!line) continue;
    const [cmd] = line.split(/\s+/);
    try {
      if (['quit', 'exit', 'q'].includes(cmd)) break;
      if (cmd === 'dump') await dumpAndShot(cdp, '手动');
      else if (cmd === 'shot') {
        const s = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
        const f = path.join(OUT_DIR, `mb-shot-${Date.now()}.png`);
        writeFileSync(f, Buffer.from(s, 'base64'));
        log(`[shot] ${path.relative(ROOT, f)}`);
      } else if (cmd === 'cookies') await exportCookies(cdp);
      else log('可用命令：dump | shot | cookies | quit');
    } catch (e) {
      log('执行出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }
  rl.close();
  await closeSession();
  log(`\n结束。产出目录：${path.relative(ROOT, OUT_DIR)}`);
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
