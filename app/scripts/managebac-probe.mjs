#!/usr/bin/env node
/**
 * ManageBac 探路脚本（只读、零依赖）
 * ==================================
 * 目标：在真正做"自动登分"之前，先把 ManageBac 的页面结构摸清楚。
 *      这一步不需要任何依赖（用你已装的 Chrome/Edge + Node 内置 WebSocket 直连 CDP），
 *      也**绝不接触账号密码** —— 登录由你在弹出的浏览器窗口里手动完成。
 *
 * 三段式计划（本文件是第 ① 段）：
 *   ① 本地探路（本脚本）：手动登录 → dump 页面结构/截图 → 确定选择器与流程
 *   ② 本地脚本化：用同一套选择器跑通"读取班级/作业/学生分数"（仍然只读）
 *   ③ 上 Worker + Browser Rendering + Cron：定时自动登分，失败发飞书告警
 *
 * 用法：
 *   node scripts/managebac-probe.mjs --url https://<你的学校>.managebac.com/login
 *   （默认 URL 为 https://www.managebac.com/login，多数学校是 <school>.managebac.com）
 *
 * 交互命令（登录后在终端输入）：
 *   dump            抓取当前页面的结构摘要（输入框/按钮/链接/表格/标题）
 *   shot            对当前页面截图
 *   goto <url>      跳转到指定 URL（例如成绩册页面）
 *   help / quit
 *
 * 输出目录：app/_ocrlab_out/mb/（已 gitignore；dump 里**只记录"是否已填"、不记录输入值**）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const PORT = 9222;
const OUT_DIR = path.resolve(process.cwd(), '_ocrlab_out', 'mb');
const PROFILE_DIR = path.join(OUT_DIR, 'profile');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const START_URL = argOf('--url', 'https://www.managebac.com/login');
// --auto：不等待人工输入，直接抓一次（结构 + 截图）后退出。用于脚本自检/CI，日常探索不用它。
const AUTO = args.includes('--auto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of BROWSERS) if (existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge，请用 --browser <路径> 指定（或改 BROWSERS 列表）');
}

async function waitForTargets(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(400);
  }
  throw new Error('等不到浏览器调试端口，请确认没有被安全软件拦截');
}

/** 极简 CDP 客户端（Node ≥21 自带 WebSocket，无需依赖） */
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
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    return cdp;
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

// 只读采集：**不采集任何输入值**，只记录"是否已填"（避免把密码/分数写进文件）
const DUMP_EXPR = `(() => {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const txt = (e) => ((e && e.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 70);
  const at = (e, names) => Object.fromEntries(names.map((n) => [n, e.getAttribute(n)]).filter(([, v]) => v));
  return JSON.stringify({
    url: location.href,
    title: document.title,
    headings: q('h1,h2,h3').map(txt).filter(Boolean).slice(0, 30),
    inputs: q('input,textarea,select').map((e) => ({
      tag: e.tagName.toLowerCase(),
      ...at(e, ['type', 'name', 'id', 'placeholder', 'aria-label', 'autocomplete']),
      filled: !!(e.value || '').length,
      inLabel: txt(e.closest('label')),
    })).slice(0, 80),
    buttons: q('button,[role=button],input[type=submit]').map((e) => ({ text: txt(e), ...at(e, ['id', 'class', 'name']) })).slice(0, 80),
    links: q('a[href]').map((e) => ({ text: txt(e), href: e.getAttribute('href') })).filter((x) => x.text).slice(0, 100),
    tables: q('table').slice(0, 5).map((t) => ({
      headers: Array.from(t.querySelectorAll('thead th, tr:first-child th, tr:first-child td')).map(txt).filter(Boolean).slice(0, 25),
      firstRows: Array.from(t.querySelectorAll('tbody tr, tr')).slice(0, 4).map((r) => Array.from(r.children).map(txt).slice(0, 25)),
    })),
    counts: { inputs: q('input,textarea,select').length, buttons: q('button,[role=button]').length, tables: q('table').length },
  }, null, 2);
})()`;

async function dump(cdp) {
  const raw = await cdp.eval(DUMP_EXPR);
  const data = JSON.parse(raw);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(OUT_DIR, `dump-${stamp}.json`);
  writeFileSync(file, raw, 'utf-8');
  console.log(`\n[dump] ${data.title || '(无标题)'}  ${data.url}`);
  console.log(`       输入框 ${data.counts.inputs} · 按钮 ${data.counts.buttons} · 表格 ${data.counts.tables}`);
  if (data.headings.length) console.log('       标题：' + data.headings.slice(0, 6).join(' | '));
  if (data.inputs.length) {
    console.log('       前几个输入框：');
    for (const i of data.inputs.slice(0, 8)) {
      console.log(`         <${i.tag}${i.type ? ' type=' + i.type : ''}${i.name ? ' name=' + i.name : ''}${i.id ? ' id=' + i.id : ''}${i.placeholder ? ' ph="' + i.placeholder + '"' : ''}> filled=${i.filled}`);
    }
  }
  if (data.tables.length) {
    console.log('       表格表头：' + data.tables.map((t) => t.headers.slice(0, 6).join(',')).join(' || '));
  }
  console.log(`       → 完整结构已写入 ${path.relative(process.cwd(), file)}`);
}

async function shot(cdp) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(OUT_DIR, `shot-${stamp}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`[shot] 已保存 ${path.relative(process.cwd(), file)}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const exe = findBrowser();
  console.log(`浏览器：${exe}`);
  console.log(`起始页：${START_URL}`);
  console.log('提示：登录请**手动完成**（本脚本不读取、不保存任何账号密码）。\n');

  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      START_URL,
    ],
    { stdio: 'ignore', detached: false },
  );

  const target = await waitForTargets();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  if (AUTO) {
    await sleep(3000); // 等页面首屏渲染
    await dump(cdp);
    await shot(cdp);
    rl.close();
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
    console.log(`\n[auto] 结束。产出目录：${path.relative(process.cwd(), OUT_DIR)}`);
    return;
  }

  await ask('登录（以及需要的话进到成绩册页面）完成后，按回车开始抓取… ');
  await dump(cdp);

  console.log('\n可用命令：dump | shot | goto <url> | help | quit');
  for (;;) {
    const line = (await ask('mb> ')).trim();
    if (!line) continue;
    const [cmd, ...rest] = line.split(/\s+/);
    try {
      if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') break;
      if (cmd === 'dump') await dump(cdp);
      else if (cmd === 'shot') await shot(cdp);
      else if (cmd === 'goto') {
        if (!rest[0]) console.log('用法：goto <url>');
        else {
          await cdp.send('Page.navigate', { url: rest[0] });
          await sleep(2500);
          await dump(cdp);
        }
      } else if (cmd === 'help') {
        console.log('dump=抓结构 · shot=截图 · goto <url>=跳转并抓取 · quit=退出');
      } else console.log('未知命令（help 看帮助）');
    } catch (e) {
      console.log('执行出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  rl.close();
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {
    /* 忽略 */
  }
  console.log(`\n结束。产出目录：${path.relative(process.cwd(), OUT_DIR)}`);
}

main().catch((e) => {
  console.error('\n失败：' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
