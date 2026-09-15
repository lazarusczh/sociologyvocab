#!/usr/bin/env node
/**
 * Cloudflare Browser Run · REST 直连探针（绕开 Worker / binding）
 * ============================================================
 * 用途：**单独**回答一个问题——「这个账号到底能不能用 Browser Run」。
 *      它不经过我们的 Worker，也不经过 wrangler 的 remote binding，
 *      从而把"本地 dev / binding 配置"从等式里剔除，直接打 Cloudflare 的 REST 端点。
 *
 * 凭据：读 app/.dev.vars 里的 CF_ACCOUNT_ID 与 CF_API_TOKEN
 *      （API Token 需要权限：Browser Rendering - Edit）
 *      **脚本只打印长度，绝不打印 token 本身。**
 *
 * 用法：
 *   node scripts/cf-browser-rest.mjs                          # 截图 https://example.com
 *   node scripts/cf-browser-rest.mjs --action content         # 只取 HTML（最快，最适合排错）
 *   node scripts/cf-browser-rest.mjs --action screenshot --url https://example.com
 *
 * 产出：_ocrlab_out/cfrest-<时间>.(png|html)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.cwd());
const DEV_VARS = path.join(ROOT, '.dev.vars');
const OUT_DIR = path.join(ROOT, '_ocrlab_out');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const ACTION = argOf('--action', 'screenshot');
const TARGET = argOf('--url', 'https://example.com');

/** 从 .dev.vars 读 KEY="value"（不打印值） */
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
  console.log('缺少凭据：请在 app/.dev.vars 里补上');
  console.log('  CF_ACCOUNT_ID="<你的 account id>"');
  console.log('  CF_API_TOKEN="<控制台新建的 API Token，权限 Browser Rendering - Edit>"');
  console.log(`（现在读到：accountId ${accountId ? '有' : '无'} · token ${token ? '有' : '无'}）`);
  process.exit(2);
}

const ENDPOINTS = {
  screenshot: 'screenshot',
  content: 'content',
  pdf: 'pdf',
  markdown: 'markdown',
};

const endpoint = ENDPOINTS[ACTION];
if (!endpoint) {
  console.log(`不支持的 --action：${ACTION}（可选：${Object.keys(ENDPOINTS).join(' / ')}）`);
  process.exit(2);
}

const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/${endpoint}`;
console.log(`REST 探针：POST /browser-rendering/${endpoint}`);
console.log(`目标：${TARGET}`);
console.log(`凭据：accountId 长度 ${accountId.length} · token 长度 ${token.length}（不回显）`);
console.log('（REST 端点不收 token 以外的参数；若失败，正文里会带 Cloudflare 的错误码/参考号）\n');

const t0 = Date.now();
let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: TARGET }),
  });
} catch (e) {
  console.log('请求失败（网络层）：' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}

const ms = Date.now() - t0;
const ctype = res.headers.get('content-type') ?? '';
console.log(`HTTP ${res.status} ${res.statusText} · ${ms}ms · content-type=${ctype}`);

const buf = Buffer.from(await res.arrayBuffer());
mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!res.ok) {
  // 失败：把 JSON 正文里的错误逐条打印（含 CF 的 code / reference）
  // 注意：content / markdown 这类动作**成功时正文也是 JSON**，故只在 !res.ok 时按错误处理。
  let parsed = null;
  try {
    parsed = JSON.parse(buf.toString('utf-8'));
  } catch {
    /* 非 JSON */
  }
  if (parsed) {
    console.log('响应正文：');
    console.log(JSON.stringify(parsed, null, 2).slice(0, 1200));
    const errs = parsed?.errors ?? [];
    for (const e of errs) {
      if (e?.message) console.log(`  → code ${e.code ?? '?'} : ${e.message}`);
    }
  } else {
    console.log('响应正文（前 400 字）：' + buf.toString('utf-8').slice(0, 400));
  }
  process.exit(1);
}

const ext = endpoint === 'screenshot' ? 'png' : endpoint === 'pdf' ? 'pdf' : 'txt';
const file = path.join(OUT_DIR, `cfrest-${stamp}.${ext}`);
writeFileSync(file, buf);
console.log(`\n[OK] ${buf.length} 字节 → ${path.relative(ROOT, file)}`);
if (ext === 'png') console.log(`      PNG magic = ${buf.subarray(1, 4).toString('ascii')}（应为 PNG）`);
if (ext !== 'png' && ext !== 'pdf') console.log(`      正文前 200 字：${buf.toString('utf-8').slice(0, 200).replace(/\s+/g, ' ')}`);
// Node 在 Windows 上退出时偶尔报 UV_HANDLE_CLOSING 断言噪音，显式退出可避免
process.exit(0);
