// 通用文本补全（主站 /app-api/* 的文本档，与视觉档 vision.ts 并列）
//
// 档位（均走线 secret，不经本地 key）：
//   nemotron = OpenRouter nvidia/nemotron-super-120b:free（免费池，约 1000 次/日；默认关推理）
//   agnes    = Agnes apihub agnes-2.5-flash（免费；注意：从 CF 出口直连曾被 WAF 1015 拒，
//              故此处**显式指定时才启用**，便于实测其可用性）
//   ms       = ModelScope Qwen3-235B（烧魔粒，仅在前两档都失败且允许降级时兜底）
//
// 调用方可用 fallback=false 关闭降级链，以便单独观测某一档的真实成功率/质量。

export interface TextEnv {
  MODELSCOPE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AGNES_API_KEY?: string;
}

export type TextTier = 'nemotron' | 'agnes' | 'ms';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const MS_CHAT_URL = 'https://api-inference.modelscope.cn/v1/chat/completions';
const OR_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AG_CHAT_URL = 'https://apihub.agnes-ai.com/v1/chat/completions';

const MS_MODEL = 'Qwen/Qwen3-235B-A22B';
const OR_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
const AG_MODEL = 'agnes-2.5-flash';

export interface TextResult {
  ok: boolean;
  text: string;
  model: string;
  tier: TextTier | 'none';
  ms: number;
  detail: string;
  fellBack: boolean;
}

interface CallOpts {
  maxTokens: number;
  temperature: number;
  system?: string;
  timeoutMs: number;
}

async function callOnce(
  tier: TextTier,
  prompt: string,
  env: TextEnv,
  opts: CallOpts,
): Promise<{ ok: boolean; status: number; text: string; detail: string; model: string }> {
  let url = '';
  let model = '';
  let key = '';
  const body: Record<string, unknown> = {
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: prompt },
    ],
    stream: false,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };

  if (tier === 'nemotron') {
    url = OR_CHAT_URL; model = OR_MODEL; key = env.OPENROUTER_API_KEY ?? '';
    body.model = model;
    body.reasoning = { enabled: false }; // nemotron 默认吐推理过程，关掉只留答案
  } else if (tier === 'agnes') {
    url = AG_CHAT_URL; model = AG_MODEL; key = env.AGNES_API_KEY ?? '';
    body.model = model;
  } else {
    url = MS_CHAT_URL; model = MS_MODEL; key = env.MODELSCOPE_API_KEY ?? '';
    body.model = model;
    body.enable_thinking = false;
  }

  if (!key) return { ok: false, status: 0, text: '', detail: `no key for ${tier}`, model };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'User-Agent': BROWSER_UA, // 免费 API 常校验 UA
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const snippet = (await r.text()).slice(0, 200).replace(/\s+/g, ' ');
      return { ok: false, status: r.status, text: '', detail: `${r.status} ${snippet}`, model };
    }
    const payload = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = payload.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) return { ok: false, status: 200, text: '', detail: 'empty content', model };
    return { ok: true, status: 200, text, detail: '', model };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, text: '', detail: `fetch ${msg}`, model };
  } finally {
    clearTimeout(timer);
  }
}

/** 顺序：指定档 → 其余档（fallback=true 时）→ 魔搭兜底 */
export async function completeText(
  prompt: string,
  tier: TextTier | 'auto',
  env: TextEnv,
  opts: Partial<CallOpts> & { fallback?: boolean } = {},
): Promise<TextResult> {
  const order: TextTier[] =
    tier === 'auto' ? ['nemotron', 'agnes', 'ms'] : [tier, ...(['nemotron', 'agnes', 'ms'] as TextTier[]).filter((t) => t !== tier)];
  const chain = opts.fallback === false ? order.slice(0, 1) : order;
  const callOpts: CallOpts = {
    maxTokens: opts.maxTokens ?? 1200,
    temperature: opts.temperature ?? 0.2,
    system: opts.system,
    timeoutMs: opts.timeoutMs ?? 120000,
  };

  const t0 = Date.now();
  for (let i = 0; i < chain.length; i++) {
    const t = chain[i];
    const res = await callOnce(t, prompt, env, callOpts);
    if (res.ok) {
      return { ok: true, text: res.text, model: res.model, tier: t, ms: Date.now() - t0, detail: '', fellBack: i > 0 };
    }
    console.error(`[ai/complete] ${t} failed: ${res.detail.slice(0, 120)}`);
    if (i === chain.length - 1) {
      return { ok: false, text: '', model: res.model, tier: 'none', ms: Date.now() - t0, detail: res.detail, fellBack: i > 0 };
    }
  }
  return { ok: false, text: '', model: '', tier: 'none', ms: Date.now() - t0, detail: 'no tiers', fellBack: false };
}
