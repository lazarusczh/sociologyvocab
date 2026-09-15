#!/usr/bin/env node
/**
 * ManageBac 成绩册 · 行级结构勘探（Browser Run + 已有 cookie，**无需再次手动登录**）
 * ===================================================================
 * 前提：已跑过 `cf-managebac-login.mjs`，`_ocrlab_out/mb-cookies.json` 在有效期内。
 * 做法：建会话 → 注入 cookie → 打开指定页面 → 抓「每个学生那一行」的结构：
 *        · 每行的 score 输入框 id / name / 已填长度
 *        · 输入框上的 data-* 属性（若含 student id，就无需按姓名匹配 ✓）
 *        · 学生链接的 href 形态（数字串掩成 :id）、行 id/class、单元格数量
 *        · 保存指示元素（Save / Save Error）的形态
 *       **学生姓名与分数值一律不输出** ✓
 *
 * 用法：
 *   node scripts/mb-explore.mjs                       # 用 mb-dump 里记录的当前 URL
 *   node scripts/mb-explore.mjs --url https://dtd.managebac.cn/teacher/classes/…/core_tasks/…
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
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

/** 从最新 dump 里取上次访问的 URL（避免手输） */
function urlFromLatestDump() {
  const files = readdirSync(OUT_DIR)
    .filter((f) => /^mb-dump-.*\.json$/.test(f))
    .map((f) => ({ f, t: statSync(path.join(OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) return '';
  try {
    return JSON.parse(readFileSync(path.join(OUT_DIR, files[0].f), 'utf-8')).url ?? '';
  } catch {
    return '';
  }
}

const TARGET = argOf('--url', urlFromLatestDump());
if (!TARGET) {
  console.log('缺少目标 URL：用 --url 指定，或先跑一次 cf-managebac-login.mjs');
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

/**
 * 带退避的请求：免费版有"1 个新实例/20 秒""10 分钟浏览器时长/天"等限制，
 * 超限返回 429（可能带 Retry-After）。这里自动等待并重试，避免手忙脚乱。
 */
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

// 行级结构（**不输出姓名与分数值**）
const ROW_EXPR = `(() => {
  const scoreInputs = Array.from(document.querySelectorAll('input[id^="grade-score-"]'));
  const rows = Array.from(document.querySelectorAll('tr'));
  const attrMap = (el) => el ? Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value])) : null;
  const dataAttrs = (el) => {
    if (!el) return null;
    const o = {};
    for (const a of el.attributes) if (a.name.startsWith('data-')) o[a.name] = a.value;
    return Object.keys(o).length ? o : null;
  };
  const shape = (s, mask) => (s ?? '').replace(mask, ':id');
  const table = rows[0] ? rows[0].closest('table') : null;
  return JSON.stringify({
    url: location.href,
    title: document.title,
    tableInfo: table ? { id: table.id || null, cls: String(table.className || '').slice(0, 80), headerCells: Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)) } : null,
    rowCount: scoreInputs.length,
    // 注意：实测 score 输入框**不在 <tr> 里**（不是经典表格行结构），
    // 因此这里改成"按输入框的祖先链"来摸真实结构。
    inputs: scoreInputs.slice(0, 3).map((inp, i) => {
      const chain = [];
      let el = inp;
      for (let d = 0; d < 9 && el; d++) {
        // 注意：这里不能再用模板字符串（外层 ROW_EXPR 本身就是模板串），用拼接
        chain.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(/\\s+/).filter(Boolean).slice(0, 2).join('.') : ''));
        el = el.parentElement;
      }
      const container = inp.closest('tr, li, tbody, [class*=student], [class*=row]') ?? inp.parentElement;
      const link = container ? container.querySelector('a[href]') : null;
      const table = inp.closest('table');
      return {
        i,
        inputId: inp.id,
        inputName: inp.getAttribute('name'),
        valueLen: (inp.value || '').length,
        inputDataAttrs: dataAttrs(inp),
        ancestors: chain,
        containerTag: container ? container.tagName.toLowerCase() : null,
        containerClass: container ? String(container.className).slice(0, 80) : null,
        containerDataAttrs: dataAttrs(container),
        containerTextLen: container ? (container.textContent || '').trim().length : 0,
        containerInputCount: container ? container.querySelectorAll('input').length : 0,
        tableId: table ? table.id || null : null,
        tableClass: table ? String(table.className).slice(0, 60) : null,
        linkHrefShape: link ? shape(link.getAttribute('href'), /[0-9]{5,}/g) : null,
        linkTextLen: link ? (link.textContent || '').trim().length : 0,
        linkDataAttrs: link ? dataAttrs(link) : null,
        // 行内各列（用于定位"姓名列"）：文本一律掩成 x/:n
        rowColumns: (() => {
          const rowEl = inp.closest('div.grid-table-row, tr');
          if (!rowEl) return null;
          return Array.from(rowEl.children).slice(0, 8).map((c) => ({
            tag: c.tagName.toLowerCase(),
            cls: String(c.className).slice(0, 70),
            textLen: (c.textContent || '').trim().length,
            hasScore: !!c.querySelector('input[id^="grade-score-"]'),
            hasLink: !!c.querySelector('a[href]'),
            linkHrefShape: (c.querySelector('a[href]') ? c.querySelector('a[href]').getAttribute('href') : '').replace(/[0-9]{5,}/g, ':id') || null,
            htmlShape: c.innerHTML
              .replace(/[A-Za-z]{2,}/g, 'x')
              .replace(/[\u4e00-\u9fff]+/g, '名') // 中文姓名同样要掩
              .replace(/[0-9]{3,}/g, ':n')
              .slice(0, 170),
          }));
        })(),
        rowTextShape: (() => {
          const rowEl = inp.closest('div.grid-table-row, tr');
          return rowEl
            ? (rowEl.textContent || '')
                .replace(/[A-Za-z]{2,}/g, 'x')
                .replace(/[\u4e00-\u9fff]+/g, '名') // 中文姓名也要掩（否则会漏出学生真名）
                .replace(/[0-9]{2,}/g, ':n')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 170)
            : null;
        })(),
      };
    }),
    saveIndicators: Array.from(document.querySelectorAll('[class*=save],[id*=save],[class*=error],[id*=error]'))
      .slice(0, 8).map((e) => ({ tag: e.tagName.toLowerCase(), id: e.id || null, cls: String(e.className || '').slice(0, 60), textLen: (e.textContent || '').trim().length, visible: !!(e.offsetWidth || e.offsetHeight) })),
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
    if (r.exceptionDetails) {
      // CDP 只给 "Uncaught" 太笼统，取真正的异常描述，便于定位页面脚本问题
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

  // 注入 cookie（登录态复用：无需再次手工登录）
  const host = new URL(TARGET).hostname;
  const usable = cookies.filter((c) => String(c.domain || '').replace(/^\./, '').endsWith(host.replace(/^[^.]+\./, '')) || String(c.domain || '').includes(host));
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
  // 成绩表是前端异步渲染的：轮询等待 score 输入框出现（最多 60 秒）
  let ready = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      ready = Number(await cdp.eval('document.querySelectorAll(\'input[id^="grade-score-"]\').length')) || 0;
    } catch {
      ready = 0;
    }
    if (i % 3 === 0) log(`  …等待成绩表渲染（score 输入框 ${ready} 个）`);
    if (ready > 0) break;
  }
  if (ready === 0) {
    // 诊断：只输出计数与可见错误类名，不输出任何页面文本（避免学生信息）
    const diag = await cdp.eval(`JSON.stringify({
      tables: document.querySelectorAll('table').length,
      trs: document.querySelectorAll('tr').length,
      coreTaskInputs: document.querySelectorAll('input[name^="core_task"]').length,
      bodyTextLen: (document.body.innerText || '').length,
      hasGradebookWord: /Task Gradebook/i.test(document.title || ''),
      iframes: Array.from(document.querySelectorAll('iframe')).map((f) => (f.getAttribute('src') || '(srcless)').replace(/[0-9]{5,}/g, ':id')).slice(0, 5),
      visibleErrors: Array.from(document.querySelectorAll('[class*=error]')).filter((e) => e.offsetWidth || e.offsetHeight).map((e) => String(e.className).slice(0, 60)).slice(0, 6),
      loadingHints: Array.from(document.querySelectorAll('[class*=load],[class*=spinner],[class*=skeleton]')).map((e) => String(e.className).slice(0, 50)).slice(0, 6),
    })`);
    log('\n⚠️ 成绩表仍未渲染。诊断（不含任何页面文本）：');
    log(JSON.stringify(JSON.parse(diag), null, 2));
    await closeSession();
    process.exit(4);
  }

  const href = await cdp.eval('location.href');
  if (/\/login/i.test(href)) {
    log(`⚠️ 落到了登录页（cookie 可能已过期）：${href}`);
    log('   解决：重跑 node scripts/cf-managebac-login.mjs 手动登录一次，再回来跑本脚本。');
    await closeSession();
    process.exit(3);
  }

  const raw = await cdp.eval(ROW_EXPR);
  const info = JSON.parse(raw);
  const file = path.join(OUT_DIR, `mb-rows-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(file, JSON.stringify(info, null, 2), 'utf-8');

  log(`\n== 页面 ==\n${info.title}\n${info.url}`);
  log(`\n== 表格 ==\n${info.tableInfo ? `id=${info.tableInfo.id} cls=${info.tableInfo.cls}` : '(未找到)'}`);
  if (info.tableInfo?.headerCells?.length) log(`表头：${info.tableInfo.headerCells.slice(0, 6).join(' | ')}`);
  log(`\n== 学生行（共 ${info.rowCount} 行，展示前 3 行结构，姓名/分数不外显）==`);
  for (const r of info.inputs ?? []) {
    log(`  #${r.i} input#${r.inputId} name=${r.inputName} 已填长度=${r.valueLen} data=${JSON.stringify(r.inputDataAttrs)}`);
    log(`      祖先链: ${(r.ancestors ?? []).join('  <  ')}`);
    log(`      容器  : <${r.containerTag} class=${r.containerClass}> 文本长度=${r.containerTextLen} 内部input=${r.containerInputCount} data=${JSON.stringify(r.containerDataAttrs)}`);
    log(`      表格  : id=${r.tableId} class=${r.tableClass}`);
    log(`      学生链接: href形态=${r.linkHrefShape} 文本长度=${r.linkTextLen} data=${JSON.stringify(r.linkDataAttrs)}`);
    if (r.rowColumns) {
      log('      行内各列:');
      for (const c of r.rowColumns) {
        log(`        <${c.tag} class=${c.cls}> 文本长度=${c.textLen} 含分数框=${c.hasScore} 含链接=${c.hasLink} href=${c.linkHrefShape ?? '-'}`);
      }
    }
    if (r.rowTextShape) log(`      整行形态: ${r.rowTextShape}`);
  }
  log(`\n== 保存相关元素 ==`);
  for (const s of info.saveIndicators ?? []) log(`  <${s.tag}${s.id ? ' id=' + s.id : ''}${s.cls ? ' class=' + s.cls : ''}> 文本长度=${s.textLen} 可见=${s.visible}`);

  log(`\n→ 结构已写入 ${path.relative(ROOT, file)}`);
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
