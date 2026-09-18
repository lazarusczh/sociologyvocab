// 视觉通道「识别质量」自检（区别于 ms-vision-check.mjs，那个只验"图片通路通不通"）。
//
// 为什么需要它：2026-09-18 教师报「OCR 能出结果但认字很差 —— blackboard 认成 textbook、IQ 认成 2a」。
// 当时用的 CF 模型（mistral-small-3.1-24b）**图片通路是通的**，色块自检 100% 通过，
// 但那点颜色题根本测不出手写识别能力。所以本脚本用**手写体文字图**测，按关键词命中率打分。
//
// 用法：
//   node scripts/vision-quality-check.mjs [图片路径]
//   不带参数则用默认图 _ocrlab_out/handwriting-check.png；图不存在时会给出生成命令。
//
// 生成测试图（PowerShell + .NET，含 blackboard / IQ / textbook 三个易错词）：
//   cd app
//   $bmp = New-Object System.Drawing.Bitmap(1000,460)
//   … 见项目记忆「视觉通道选型的三个坑」一节，或直接问 codebuddy 要这段命令
//
// 判据：15 个关键词（blackboard / IQ / textbook / Marx / cultural capital …）命中数。
//   15/15 = 完全正确；明显漏词或串词（如 textbook 出现在不该出现处）= 该模型不适合当主力。
//
// 注意：本脚本会真实调用模型（每次约 1 张图，几百 KB 以内）。
//   魔搭侧按全账号 ~250 魔粒/日 计，**不要反复跑**；OpenRouter 免费档不耗魔粒但有限流。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = join(scriptDir, '..');

/** 从 .dev.vars 读 key */
function readKey(name) {
  const txt = readFileSync(join(appDir, '.dev.vars'), 'utf8');
  const m = txt.match(new RegExp(`${name}\\s*=\\s*['"]?([^'"\\r\\n]+)`));
  return m ? m[1] : '';
}

/** 从 worker/ai/models.ts 读模型 id，避免脚本与代码不同步 */
function readModels() {
  const txt = readFileSync(join(appDir, 'worker', 'ai', 'models.ts'), 'utf8');
  const get = (name) => (txt.match(new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`)) || [])[1] || '';
  return { visionOr: get('MS_VISION_OR'), visionMs: get('MS_VISION') };
}

const imgPath = process.argv[2] || join(appDir, '_ocrlab_out', 'handwriting-check.png');
if (!existsSync(imgPath)) {
  console.error(`测试图不存在：${imgPath}`);
  console.error('请先生成（PowerShell + System.Drawing，用 Ink Free / Segoe Script 字体写几行英文），');
  console.error('或传入已有手写图片路径作为参数。');
  process.exit(1);
}
const dataUrl = 'data:image/png;base64,' + readFileSync(imgPath).toString('base64');

// 真值关键词：模型认错字 / 串词就会丢分
const KEYWORDS = [
  'blackboard', 'shows', 'results', 'experiment', 'cultural capital',
  'Marx', 'argued', 'IQ', 'measures', 'familiarity', 'textbook',
  'Evaluate', 'claim', '26', 'p.47',
];

const PROMPT = '请把这页手写内容逐字转写成文本。不要翻译、不要解释、不要总结，只输出转写正文。';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function askOpenRouter(model, key) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://9699vocab.cn',
      'X-Title': 'Vocabulary Project OCR check',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: PROMPT }] }],
      temperature: 0,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(150_000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200) {
    const note = j?.error?.message || JSON.stringify(j).slice(0, 130);
    const hint = r.status === 429 ? '（免费池拥挤，稍后重试）'
      : r.status === 403 ? '（该免费模型不允许 API 调用，换一个）' : '';
    return { ok: false, note: `HTTP ${r.status}: ${note}${hint}` };
  }
  const c = j?.choices?.[0]?.message?.content ?? '';
  return c.trim() ? { ok: true, text: c } : { ok: false, note: 'HTTP 200 但内容为空' };
}

async function askModelScope(model, key) {
  const r = await fetch('https://api-inference.modelscope.cn/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': UA },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: PROMPT }] }],
      temperature: 0,
      max_tokens: 2048,
      enable_thinking: false,
    }),
    signal: AbortSignal.timeout(150_000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200) return { ok: false, note: `HTTP ${r.status}: ${(j?.error?.message || '').slice(0, 130)}` };
  const c = j?.choices?.[0]?.message?.content ?? '';
  return c.trim() ? { ok: true, text: c } : { ok: false, note: 'HTTP 200 但内容为空' };
}

function score(text) {
  const low = text.toLowerCase();
  const hits = KEYWORDS.filter((k) => low.includes(k.toLowerCase()));
  return { hit: hits.length, missed: KEYWORDS.filter((k) => !hits.includes(k)) };
}

const { visionOr, visionMs } = readModels();
const orKey = readKey('OPENROUTER_API_KEY');
const msKey = readKey('MODELSCOPE_API_KEY');

const TARGETS = [
  ['OpenRouter', visionOr, orKey],
  ['魔搭', visionMs, msKey],
  // 备选（想换时取消注释即可 —— 注意 OR 免费档 429/403 的坑，见 models.ts 注释）
  // ['OpenRouter', 'dots-studio/dots-3-note-preview:free', orKey],
  // ['OpenRouter', 'qwen/qwen3.8-27b:free', orKey],
  // ['魔搭', 'Qwen/Qwen3.8-27B', msKey],
].filter(([, m]) => m);

console.log(`图片：${imgPath}`);
console.log(`关键词 ${KEYWORDS.length} 个，命中越多越准（15/15 为完全正确）\n`);

for (const [provider, model, key] of TARGETS) {
  if (!key) {
    console.log(`${model.padEnd(50)}跳过：缺 key`);
    continue;
  }
  const t0 = Date.now();
  let res;
  try {
    res = provider === 'OpenRouter' ? await askOpenRouter(model, key) : await askModelScope(model, key);
  } catch (e) {
    res = { ok: false, note: e.name === 'TimeoutError' ? '超时(150s)' : e.message };
  }
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.log(`${model.padEnd(50)}失败  ${String(ms).padStart(6)}ms  ${res.note}`);
  } else {
    const s = score(res.text);
    console.log(`${model.padEnd(50)}${s.hit}/${KEYWORDS.length}  ${String(ms).padStart(6)}ms  ${provider}`);
    if (s.missed.length) console.log(`${' '.repeat(50)}  漏: ${s.missed.join(', ')}`);
    console.log(`${' '.repeat(50)}  首行: ${res.text.replace(/\s+/g, ' ').slice(0, 96)}`);
  }
}
