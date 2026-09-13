// 视觉转写（主站 OCR 辅助阅卷用）：图片 → 文本，走魔搭 ModelScope（OpenAI 兼容多模态）。
//
// 档位策略：主力 Qwen3-VL-235B（实测 13 秒/页、质量达标）→ 失败降级 Qwen3-VL-8B（快但会丢内容）。
// 隐私口径：Worker 只把图片转发给模型，**不落盘、不留存**；返回文本后由前端自行保存。

import { BROWSER_UA, MS_CHAT_URL, MS_VISION, MS_VISION_FALLBACK, TRANSCRIBE_PROMPT } from './models';

export interface VisionEnv {
  MODELSCOPE_API_KEY?: string;
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

async function callVision(
  model: string,
  dataUrl: string,
  key: string,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number; detail: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(MS_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'User-Agent': BROWSER_UA,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: TRANSCRIBE_PROMPT },
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
      const snippet = (await r.text()).slice(0, 200);
      return { ok: false, status: r.status, detail: snippet };
    }
    const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) return { ok: false, status: 502, detail: 'empty completion' };
    return { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, detail: `fetch ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 转写单页。images 以 data URL 传入（data:image/png;base64,...） */
export async function transcribePage(
  dataUrl: string,
  env: VisionEnv,
  timeoutMs = 120_000,
): Promise<TranscribeOk | TranscribeFail> {
  const key = env.MODELSCOPE_API_KEY;
  if (!key) return { ok: false, status: 500, detail: 'MODELSCOPE_API_KEY 未配置（本地请写入 app/.dev.vars）' };
  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl)) {
    return { ok: false, status: 400, detail: 'image must be a data URL (png/jpeg/webp)' };
  }

  const t0 = Date.now();
  const main = await callVision(MS_VISION, dataUrl, key, timeoutMs);
  if (main.ok) return { ok: true, text: main.text, model: MS_VISION, ms: Date.now() - t0, fellBack: false };

  console.error(`[app-api/transcribe] ${MS_VISION} failed ${main.status}: ${main.detail.slice(0, 120)}`);
  const fb = await callVision(MS_VISION_FALLBACK, dataUrl, key, timeoutMs);
  if (fb.ok) {
    return { ok: true, text: fb.text, model: MS_VISION_FALLBACK, ms: Date.now() - t0, fellBack: true };
  }
  return { ok: false, status: fb.status || main.status || 502, detail: `${main.detail} | fallback ${fb.detail}` };
}
