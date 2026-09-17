#!/usr/bin/env node
// 魔搭（ModelScope）模型 id 自检。
//
// 为什么需要它：魔搭的模型 id 会**过期**。2026-09-17 就出了一次 —— 整个 `Qwen/Qwen3-*`
// 系列被下架（换代成 Qwen3.5），调用一律返回 400 `Model id : ... , has no provider supported`。
// 那次界面只显示了错误的前 40 个字符，教师把它误读成了「rate limit」，白查了一阵。
//
// 用法（在 app/ 下）：
//   node scripts/ms-models.mjs          逐个探测源码里用到的模型 id（每个 1 token，极省额度）
//   node scripts/ms-models.mjs --list   只列账号可见模型，不探测（完全不耗额度）
//
// 模型 id 直接从源码里正则提取（worker/ai/models.ts 与 worker.ts），
// 所以本脚本永远与代码同步，不需要另外维护一份清单（那正是会忘记更新的东西）。
// 密钥读 app/.dev.vars 的 MODELSCOPE_API_KEY，不打印、不外传。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

const MS_BASE = 'https://api-inference.modelscope.cn/v1';
const MS_CHAT = `${MS_BASE}/chat/completions`;
const MS_MODELS = `${MS_BASE}/models`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

function readKey() {
  const txt = readFileSync(join(appDir, '.dev.vars'), 'utf8');
  const m = txt.match(/MODELSCOPE_API_KEY\s*=\s*['"]?([^'"\r\n]+)/);
  if (!m) throw new Error('app/.dev.vars 里没有 MODELSCOPE_API_KEY');
  return m[1].trim();
}

/** 从源码抓出所有魔搭模型 id（形如 `const MS_XXX = '供应商/模型'`） */
function collectIds() {
  // 注意：**必须把所有持有模型常量的文件列全**。2026-09-17 就漏了 worker/ai/text.ts
  // （主站 complete 的魔搭兜底档），导致脚本报「全部可用」而实际主站是坏的。
  const files = [
    join(appDir, 'worker', 'ai', 'models.ts'),
    join(appDir, 'worker', 'ai', 'text.ts'),
    join(appDir, 'worker.ts'),
  ];
  const out = [];
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/(?:export\s+)?const\s+(MS_[A-Z0-9_]+)\s*=\s*'([^']+)'/g)) {
      if (/^https?:/i.test(m[2])) continue; // 跳过 URL 常量（MS_BASE_URL / MS_URL 不是模型 id）
      if (/^@cf\//.test(m[2])) continue; // 跳过 Cloudflare Workers AI 的模型（不属魔搭，探它会报 Invalid model id）
      const rel = f.slice(appDir.length + 1).split('\\').join('/');
      out.push({ name: m[1], id: m[2], file: rel });
    }
  }
  return out;
}

async function listVisible(key) {
  const r = await fetch(MS_MODELS, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA } });
  if (!r.ok) throw new Error(`GET /v1/models 返回 HTTP ${r.status}`);
  const j = await r.json();
  return new Set((j.data ?? []).map((x) => x.id));
}

/** 探测单个模型：只发 1 个 token，尽量不耗额度 */
async function probe(key, id) {
  try {
    const r = await fetch(MS_CHAT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': UA },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    });
    const txt = (await r.text()).replace(/\s+/g, ' ');
    if (r.status === 200) {
      let hasContent = false;
      try {
        hasContent = Boolean(JSON.parse(txt).choices?.[0]);
      } catch {
        /* 非 JSON，按异常处理 */
      }
      return hasContent
        ? { ok: true }
        : { ok: false, why: 'HTTP 200 但返回内容为空（免费池瞬时不可用，稍后重试即可；不必换 id）' };
    }
    let msg = txt.slice(0, 200);
    try {
      const j = JSON.parse(txt);
      if (typeof j.error === 'string') msg = j.error;
      else if (j.error?.message) msg = j.error.message;
    } catch {
      /* 网关错误页等，保留原始片段 */
    }
    return { ok: false, why: `HTTP ${r.status}：${msg}` };
  } catch (e) {
    return { ok: false, why: `请求异常：${e.message}` };
  }
}

const key = readKey();
const onlyList = process.argv.includes('--list');
const ids = collectIds();

const visible = await listVisible(key);
console.log(`账号可见模型 ${visible.size} 个（GET /v1/models）`);
for (const { name, id, file } of ids) {
  console.log(`  ${visible.has(id) ? '在列表  ' : '不在列表'}  ${name} = ${id}   (${file})`);
}

if (onlyList) {
  console.log('\n（--list 模式，未逐个探测，不消耗额度）');
  process.exit(0);
}

console.log('\n逐个探测（每个 1 token）：');
let bad = 0;
for (const { name, id, file } of ids) {
  const r = await probe(key, id);
  if (r.ok) {
    console.log(`  可用    ${name} = ${id}`);
  } else {
    bad++;
    console.log(`  不可用  ${name} = ${id}   (${file})`);
    console.log(`          ${r.why}`);
  }
}
console.log(
  bad
    ? `\n有 ${bad} 个模型 id 不可用。换 id 时先看上方的「账号可见模型」列表里的同类模型，别照抄记忆里的旧 id。`
    : '\n全部可调用。',
);
