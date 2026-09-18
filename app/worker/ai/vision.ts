// 视觉转写（主站 OCR 辅助阅卷用）：图片 → 文本，走魔搭 ModelScope（OpenAI 兼容多模态）。
//
// 档位策略：主力 Qwen3-VL-235B（实测 13 秒/页、质量达标）→ 失败降级 Qwen3-VL-8B（快但会丢内容）。
// 隐私口径：Worker 只把图片转发给模型，**不落盘、不留存**；返回文本后由前端自行保存。

import { BROWSER_UA, MS_CHAT_URL, OR_CHAT_URL, MS_VISION, MS_VISION_CF, MS_VISION_OR, TRANSCRIBE_PROMPT } from './models';
import { PROBE_IMAGE_DATA_URL } from './probeImage';

export interface VisionEnv {
  MODELSCOPE_API_KEY?: string;
  /** OpenRouter key（视觉主力，免费档不耗魔搭魔粒） */
  OPENROUTER_API_KEY?: string;
  /** Cloudflare Workers AI 绑定（视觉兜底）。只声明用到的形状，不依赖 CF 的类型包 */
  AI?: { run: (model: string, inputs: unknown) => Promise<unknown> };
}

export interface TranscribeOk {
  ok: true;
  text: string;
  model: string;
  ms: number;
  fellBack: boolean;
}
export interface TranscribeFail {
  ok: false;
  status: number;
  detail: string;
}

/**
 * 把「非 200」响应整理成一句人话。
 *
 * 魔搭的失败体形如 `{"error":{"message":"Model id : xxx , has no provider supported"}}`，
 * 原样透传的话前端只能看到一坨 JSON —— 2026-09-17 教师正是因此把「模型已下架」
 * 误读成了「rate limit」（当时界面还只显示前 40 个字符）。
 * 这里优先取出 message，并针对常见情形补一句该怎么办，最后附原始片段备查。
 */
async function describeFailure(r: Response): Promise<string> {
  const raw = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim();
  let msg = '';
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === 'string') msg = j.error;
    else if (j.error?.message) msg = j.error.message;
    else if (j.message) msg = j.message;
  } catch {
    // 不是 JSON（网关错误页等）→ 下面直接回落到原始片段
  }
  if (!msg) return `HTTP ${r.status}：${raw.slice(0, 300) || '（无响应内容）'}`;
  const hint = r.status === 429
    ? '（触发限流，稍等片刻再试）'
    : /has no provider supported/i.test(msg)
      ? '（该模型已下架或本账号不可用，需要换模型 id —— 先跑 node scripts/ms-models.mjs 对照实际可用列表）'
      : '';
  return `HTTP ${r.status}：${msg.slice(0, 400)}${hint}`;
}

async function callVision(
  model: string,
  dataUrl: string,
  key: string,
  timeoutMs: number,
  prompt: string = TRANSCRIBE_PROMPT,
  endpoint: string = MS_CHAT_URL,
  extraHeaders: Record<string, string> = {},
): Promise<{ ok: true; text: string } | { ok: false; status: number; detail: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'User-Agent': BROWSER_UA,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 4096,
        enable_thinking: false,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      return { ok: false, status: r.status, detail: await describeFailure(r) };
    }
    const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? '';
    // 200 但内容为空：魔搭免费池时好时坏，常出现「状态正常、choices 为 null」的空响应
    if (!text.trim()) return { ok: false, status: 502, detail: `empty completion（HTTP 200 但没有内容，多为免费池瞬时不可用）` };
    return { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, detail: `fetch ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** data URL → 字节数组（Workers AI 的另一种传图形制要这个） */
function dataUrlToBytes(dataUrl: string): number[] {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out: number[] = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 从 Workers AI 的返回值里取正文（同步返回字段是 `response`，不是 choices） */
function pickAiText(out: unknown): string {
  if (typeof out === 'string') return out;
  const r = (out as { response?: unknown })?.response;
  return typeof r === 'string' ? r : '';
}

/**
 * 视觉兜底：走 Cloudflare Workers AI（**完全不依赖魔搭**）。
 * 任何失败都返回失败对象、不抛异常 —— 它是最后一档，不该把整个请求炸掉。
 *
 * 传图形制在 Workers AI 内部并不统一（`image_url` + data URL 与 `image` + 字节数组两种都有人用），
 * 官方文档该模型的参数表也没列图像字段 ⇒ 两种都试一遍，避免来回试错。
 * 每次失败都写 console，便于在 wrangler 日志里定位。
 */
async function callWorkersAI(
  ai: { run: (model: string, inputs: unknown) => Promise<unknown> },
  dataUrl: string,
  prompt: string = TRANSCRIBE_PROMPT,
): Promise<{ ok: true; text: string } | { ok: false; status: number; detail: string }> {
  const attempts: unknown[] = [
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 4096,
    },
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', image: dataUrlToBytes(dataUrl) },
          ],
        },
      ],
      max_tokens: 4096,
    },
  ];

  let last = '';
  for (let i = 0; i < attempts.length; i++) {
    try {
      const text = pickAiText(await ai.run(MS_VISION_CF, attempts[i]));
      if (text.trim()) return { ok: true, text };
      last = `第 ${i + 1} 种传图形制返回空内容`;
      console.error(`[transcribe] ${MS_VISION_CF} ${last}`);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      console.error(`[transcribe] ${MS_VISION_CF} 第 ${i + 1} 种传图形制失败：${last.slice(0, 200)}`);
    }
  }
  return { ok: false, status: 502, detail: `Workers AI（${MS_VISION_CF}）失败：${last.slice(0, 200)}` };
}

/** 转写单页。images 以 data URL 传入（data:image/png;base64,...） */
export async function transcribePage(
  dataUrl: string,
  env: VisionEnv,
  timeoutMs = 120_000,
): Promise<TranscribeOk | TranscribeFail> {
  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl)) {
    return { ok: false, status: 400, detail: 'image must be a data URL (png/jpeg/webp)' };
  }

  const t0 = Date.now();
  const fails: string[] = [];

  // ① OpenRouter（视觉主力）：质量达标且**免费、不耗魔搭魔粒**，故排第一档。
  //    2026-09-18 实测手写图 15/15 关键词命中，约 6 秒/页。
  const orKey = env.OPENROUTER_API_KEY;
  if (orKey) {
    const or = await callVision(MS_VISION_OR, dataUrl, orKey, timeoutMs, TRANSCRIBE_PROMPT, OR_CHAT_URL, {
      'HTTP-Referer': 'https://9699vocab.cn',
      'X-Title': 'Vocabulary Project OCR',
    });
    if (or.ok) return { ok: true, text: or.text, model: MS_VISION_OR, ms: Date.now() - t0, fellBack: false };
    fails.push(`OpenRouter（${MS_VISION_OR}）：${or.detail}`);
    console.error(`[app-api/transcribe] ${MS_VISION_OR} failed ${or.status}: ${or.detail.slice(0, 140)}`);
  } else {
    fails.push('OpenRouter：OPENROUTER_API_KEY 未配置');
  }

  // ② 魔搭 `Qwen/Qwen3.5-122B-A10B`：最快（约 1 秒/页）但**耗魔粒**，故排在免费通道之后。
  //    ⚠ 曾经的错法：只挑名字带 `VL` 的模型 —— 那两个一律空响应。Qwen3.5/3.8 自带视觉，不要按名字找。
  const key = env.MODELSCOPE_API_KEY;
  if (!key) {
    fails.push('魔搭：MODELSCOPE_API_KEY 未配置（本地请写入 app/.dev.vars）');
  } else {
    const main = await callVision(MS_VISION, dataUrl, key, timeoutMs);
    if (main.ok) return { ok: true, text: main.text, model: MS_VISION, ms: Date.now() - t0, fellBack: true };
    fails.push(`${MS_VISION}：${main.detail}`);
    console.error(`[app-api/transcribe] ${MS_VISION} failed ${main.status}: ${main.detail.slice(0, 140)}`);
  }

  // ③ Cloudflare Workers AI：最后一档，只为「外部通道全挂时至少还能出一版结果」。
  //    质量差是已知的（教师实测 blackboard→textbook、IQ→2a），所以排在最后而非最前。
  if (env.AI) {
    const cf = await callWorkersAI(env.AI, dataUrl);
    if (cf.ok) return { ok: true, text: cf.text, model: MS_VISION_CF, ms: Date.now() - t0, fellBack: true };
    fails.push(`CF：${cf.detail}`);
    console.error(`[app-api/transcribe] ${MS_VISION_CF} failed: ${cf.detail.slice(0, 140)}`);
  } else {
    fails.push('CF：没有 AI 绑定');
  }

  return { ok: false, status: 502, detail: fails.join(' | ') };
}

export interface VisionProbe {
  channel: string;
  ok: boolean;
  ms: number;
  note: string;
}

/**
 * 逐条通道自检：用内置小图问「几个矩形、什么颜色」，判断通道**是否真的看得见图片**。
 * 用具：不占教师任何答卷、图只有几百字节；魔搭那两个模型不处理请求因此也不计魔粒。
 * 2026-09-17 加 —— 通道挂掉时能一眼看出挂在哪一档，而不是对着一句报错猜。
 */
export async function probeVisionChannels(env: VisionEnv): Promise<VisionProbe[]> {
  const ask = '这张图里有几个矩形？从左到右分别是什么颜色？只用一句话回答数量与颜色。';
  const out: VisionProbe[] = [];

  // 顺序与 transcribePage 的降级链保持一致，便于一眼看出「挂在哪一档」。
  const orKey = env.OPENROUTER_API_KEY;
  if (orKey) {
    const t0 = Date.now();
    const r = await callVision(MS_VISION_OR, PROBE_IMAGE_DATA_URL, orKey, 60_000, ask, OR_CHAT_URL, {
      'HTTP-Referer': 'https://9699vocab.cn',
      'X-Title': 'Vocabulary Project OCR',
    });
    out.push({
      channel: `${MS_VISION_OR}（OpenRouter）`,
      ok: r.ok,
      ms: Date.now() - t0,
      note: r.ok ? r.text.replace(/\s+/g, ' ').slice(0, 140) : r.detail.slice(0, 200),
    });
  } else {
    out.push({ channel: `${MS_VISION_OR}（OpenRouter）`, ok: false, ms: 0, note: 'OPENROUTER_API_KEY 未配置' });
  }

  const key = env.MODELSCOPE_API_KEY;
  if (!key) {
    out.push({ channel: `${MS_VISION}（魔搭）`, ok: false, ms: 0, note: 'MODELSCOPE_API_KEY 未配置' });
  } else {
    const t0 = Date.now();
    const r = await callVision(MS_VISION, PROBE_IMAGE_DATA_URL, key, 60_000, ask);
    out.push({
      channel: `${MS_VISION}（魔搭）`,
      ok: r.ok,
      ms: Date.now() - t0,
      note: r.ok ? r.text.replace(/\s+/g, ' ').slice(0, 140) : r.detail.slice(0, 200),
    });
  }

  if (env.AI) {
    const t0 = Date.now();
    const r = await callWorkersAI(env.AI, PROBE_IMAGE_DATA_URL, ask);
    out.push({
      channel: `${MS_VISION_CF}（CF，质量差，仅兜底）`,
      ok: r.ok,
      ms: Date.now() - t0,
      note: r.ok ? r.text.replace(/\s+/g, ' ').slice(0, 140) : r.detail.slice(0, 200),
    });
  } else {
    out.push({ channel: `${MS_VISION_CF}（CF）`, ok: false, ms: 0, note: '没有 AI 绑定' });
  }

  return out;
}
