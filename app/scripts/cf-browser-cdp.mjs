#!/usr/bin/env node
/**
 * Cloudflare Browser Run · REST 建会话 + CDP 驱动（**不依赖 Workers binding**）
 * =====================================================================
 * 为什么需要它：本项目环境下 `[browser] binding` 创建会话稳定 500（见 project-memory），
 * 但 REST 端点完全可用 → 于是改用官方文档的「CDP 路线」：
 *   POST /devtools/browser?keep_alive=600000   → { sessionId, webSocketDebuggerUrl }
 *   PUT  /devtools/browser/{sid}/json/new?url= → 新标签页（返回页面级 wss 地址 + jwt）
 *   （CDP over WebSocket：导航 / 执行 JS / 截图）
 *   DELETE /devtools/browser/{sid}             → 立刻关闭（免费版每天仅 10 分钟浏览器时长，务必关）
 *
 * 凭据：读 app/.dev.vars 的 CF_ACCOUNT_ID / CF_API_TOKEN（**不打印 token**）
 * 用法：
 *   node scripts/cf-browser-cdp.mjs                                  # 打开 example.com 并截图
 *   node scripts/cf-browser-cdp.mjs --url https://<school>.managebac.com/login
 *   node scripts/cf-browser-cdp.mjs --keep 120000                    # 自定义 keep_alive
 *
 * 产出：_ocrlab_out/cfcdp-<时间>.png + 结构摘要打印
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.cwd());
const DEV_VARS = path.join(ROOT, '.dev.vars');
const OUT_DIR = path.join(ROOT, '_ocrlab_out');

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const TARGET = argOf('--url', 'https://example.com');
const KEEP_ALIVE = Number(argOf('--keep', '600000'));

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
  console.log('缺少凭据：请在 app/.dev.vars 里补 CF_ACCOUNT_ID 与 CF_API_TOKEN');
  process.exit(2);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering`;
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log(...a);

// 只读采集页面结构（不含输入值，只记 filled 布尔）
const DUMP_EXPR = `(() => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const txt = (e) => ((e && e.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 70);
  return JSON.stringify({
    url: location.href, title: document.title,
    headings: q('h1,h2,h3').map(txt).filter(Boolean).slice(0, 20),
    inputs: q('input,textarea,select').map((e) => ({ tag: e.tagName.toLowerCase(), type: e.getAttribute('type'), name: e.getAttribute('name'), id: e.getAttribute('id'), placeholder: e.getAttribute('placeholder'), filled: !!(e.value || '').length })).slice(0, 40),
    buttons: q('button,[role=button],input[type=submit]').map(txt).filter(Boolean).slice(0, 40),
    links: q('a[href]').map((e) => ({ t: txt(e), h: e.getAttribute('href') })).filter((x) => x.t).slice(0, 40),
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
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败（检查 jwt 是否已过期）')), { once: true });
    });
    const c = new Cdp(ws);
    await c.send('Page.enable');
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面脚本执行失败');
    return r.result?.value;
  }
}

let sessionId = '';
async function closeSession() {
  if (!sessionId) return;
  try {
    const r = await fetch(`${BASE}/devtools/browser/${sessionId}`, { method: 'DELETE', headers: H });
    log(`[cleanup] DELETE session → HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
  } catch (e) {
    log('[cleanup] 关闭会话失败：' + (e instanceof Error ? e.message : String(e)));
  }
}

async function findTargetViaList() {
  try {
    const r = await fetch(`${BASE}/devtools/browser/${sessionId}/json/list`, { headers: H });
    const body = await r.json();
    if (!r.ok || !Array.isArray(body)) {
      log(`  json/list 兜底失败 HTTP ${r.status}：${JSON.stringify(body).slice(0, 200)}`);
      return null;
    }
    return body.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
  } catch (e) {
    log('  json/list 异常：' + (e instanceof Error ? e.message : String(e)));
    return null;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  log(`创建会话（keep_alive=${KEEP_ALIVE}ms）…`);
  const cr = await fetch(`${BASE}/devtools/browser?keep_alive=${KEEP_ALIVE}`, { method: 'POST', headers: H });
  const cj = await cr.json();
  if (!cr.ok || !cj?.sessionId) {
    log(`创建会话失败 HTTP ${cr.status}：${JSON.stringify(cj).slice(0, 400)}`);
    process.exit(1);
  }
  sessionId = cj.sessionId;
  log(`会话就绪 sessionId=${sessionId}（${Date.now() - t0}ms）`);

  log(`新标签页 → ${TARGET}`);
  const nr = await fetch(`${BASE}/devtools/browser/${sessionId}/json/new?url=${encodeURIComponent(TARGET)}`, {
    method: 'PUT',
    headers: H,
  });
  const nj = await nr.json();
  if (!nr.ok) {
    log(`新建标签页失败 HTTP ${nr.status}：${JSON.stringify(nj).slice(0, 300)}`);
    await closeSession();
    process.exit(1);
  }
  log(`标签页 ${nj.id} · title=${JSON.stringify(nj.title)}`);
  log(`  json/new 返回字段：${Object.keys(nj).join(', ')}`);

  // 优先直接用 json/new 响应里的页面级 wss 地址（文档第 2 步的字段表里就有）；
  // json/list 在实测中可能返回 {"success":false,"errors":[{"message":"Gone"}]}，故仅作兜底。
  let page = nj && nj.webSocketDebuggerUrl ? nj : null;
  if (!page) page = (await findTargetViaList()) ?? null;
  if (!page) {
    log('拿不到页面级 webSocketDebuggerUrl：' + JSON.stringify(targets).slice(0, 300));
    await closeSession();
    process.exit(1);
  }
  log(`连接到 CDP（${page.webSocketDebuggerUrl.split('?')[0].slice(0, 72)}…）`);

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await sleep(1200);
  const dump = JSON.parse(await cdp.eval(DUMP_EXPR));
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const png = path.join(OUT_DIR, `cfcdp-${stamp}.png`);
  writeFileSync(png, Buffer.from(shot, 'base64'));

  log('\n== 页面 ==');
  log(`url   : ${dump.url}`);
  log(`title : ${dump.title}`);
  log(`标题  : ${dump.headings.slice(0, 5).join(' | ')}`);
  log(`输入框: ${dump.inputs.length} 个${dump.inputs.slice(0, 5).map((i) => ` [${i.type || i.tag}${i.name ? ' name=' + i.name : ''}]`).join('')}`);
  log(`按钮  : ${dump.buttons.slice(0, 8).join(' / ')}`);
  log(`截图  : ${path.relative(ROOT, png)}（${Math.round(Buffer.from(shot, 'base64').length / 1024)} KB）`);
  log(`\n本次消耗浏览器时长约 ${((Date.now() - t0) / 1000).toFixed(1)} 秒（免费额度 10 分钟/天）`);

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
