#!/usr/bin/env node
// 视觉通道自检：造一张确定内容的图，问模型「看到了什么」，以此判断图片通路是否真的通。
//
// 为什么单独做这个：`ms-models.mjs` 用纯文本探测，视觉模型会回「HTTP 200 但内容为空」——
// 这既可能是免费池抖动，也可能是模型不接受纯文本输入，光看它分不清（2026-09-17 遇到）。
// 本脚本自带一个极小的 PNG 编码器（只用 node 内置 zlib），画一张三色块的图发给模型，
// 模型答对「三个矩形、红绿蓝」即说明图片通路正常。不依赖任何图片素材。
//
// 用法（在 app/ 下）：
//   node scripts/ms-vision-check.mjs              测默认的两个视觉模型
//   node scripts/ms-vision-check.mjs 模型id ...   测指定模型
//
// 图片会同时写到 app/_ocrlab_out/vision-check.png 方便人眼核对（该目录已 gitignore）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// ---------- 极小 PNG 编码器（RGB、8 位、无压缩以外的花样） ----------

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(w, h, draw) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const off = y * stride;
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = draw(x, y);
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 三块纯色矩形：左红、中绿、右蓝 */
function buildTestImage() {
  const W = 480;
  const H = 240;
  const png = makePng(W, H, (x, y) => {
    if (y >= 60 && y < 180) {
      if (x >= 40 && x < 160) return [220, 40, 40];
      if (x >= 180 && x < 300) return [40, 170, 60];
      if (x >= 320 && x < 440) return [40, 80, 220];
    }
    return [255, 255, 255];
  });
  return png;
}

// ---------- 探测 ----------

function readKey() {
  const txt = readFileSync(join(appDir, '.dev.vars'), 'utf8');
  const m = txt.match(/MODELSCOPE_API_KEY\s*=\s*['"]?([^'"\r\n]+)/);
  if (!m) throw new Error('app/.dev.vars 里没有 MODELSCOPE_API_KEY');
  return m[1].trim();
}

/** 从 worker/ai/models.ts 读默认的视觉模型 id */
function defaultModels() {
  const txt = readFileSync(join(appDir, 'worker', 'ai', 'models.ts'), 'utf8');
  const out = [];
  for (const name of ['MS_VISION', 'MS_VISION_FALLBACK']) {
    const m = txt.match(new RegExp(`const\\s+${name}\\s*=\\s*'([^']+)'`));
    if (m) out.push({ name, id: m[1] });
  }
  return out;
}

const PROMPT = '这张图里有几个矩形？从左到右分别是什么颜色？只用一句话回答数量与颜色。';

async function ask(key, model, dataUrl) {
  const t0 = Date.now();
  const r = await fetch('https://api-inference.modelscope.cn/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': UA },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 200,
    }),
  });
  const txt = await r.text();
  const ms = Date.now() - t0;
  if (r.status !== 200) {
    let msg = txt.slice(0, 200);
    try {
      const j = JSON.parse(txt);
      if (typeof j.error === 'string') msg = j.error;
      else if (j.error?.message) msg = j.error.message;
    } catch {
      /* 保留原始片段 */
    }
    return { ok: false, why: `HTTP ${r.status}：${msg}`, ms };
  }
  let content = '';
  try {
    content = JSON.parse(txt).choices?.[0]?.message?.content ?? '';
  } catch {
    /* ignore */
  }
  if (!content.trim()) return { ok: false, why: `HTTP 200 但内容为空（连图片也拿不到响应）`, ms };
  return { ok: true, content: content.trim(), ms };
}

/** 答对判据：说出 3 个矩形，且红绿蓝三种颜色齐全 */
function judge(text) {
  const t = text.toLowerCase();
  const hasThree = /三|3|three/.test(t);
  const colors = ['红', 'red', '绿', 'green', '蓝', 'blue'].filter((c) => t.includes(c));
  const grouped = ['红|red', '绿|green', '蓝|blue'].filter((p) => new RegExp(p).test(t)).length;
  return { pass: hasThree && grouped === 3, hasThree, colorKinds: grouped, colors };
}

const key = readKey();
const png = buildTestImage();
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

const outDir = join(appDir, '_ocrlab_out');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'vision-check.png'), png);
console.log(`测试图已生成：_ocrlab_out/vision-check.png（${png.length} 字节，base64 ${dataUrl.length} 字节）`);

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = argv.length ? argv.map((id) => ({ name: '(命令行指定)', id })) : defaultModels();

console.log('\n逐个用图片探测：');
for (const { name, id } of targets) {
  const r = await ask(key, id, dataUrl);
  if (!r.ok) {
    console.log(`  不通    ${name} = ${id}`);
    console.log(`          ${r.why}`);
    continue;
  }
  const v = judge(r.content);
  console.log(`  ${v.pass ? '正常' : '存疑'}    ${name} = ${id}   (${r.ms}ms)`);
  console.log(`          模型答：${r.content.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (!v.pass) console.log(`          判据未满足：提到数量=${v.hasThree}，识别到的颜色数=${v.colorKinds}`);
}
console.log('\n说明：判据未满足只表示「这次没答对」，可能是免费池抖动或模型能力弱；');
console.log('同一模型多跑几次仍不正常，才考虑换 id（见 ms-models.mjs）。');
