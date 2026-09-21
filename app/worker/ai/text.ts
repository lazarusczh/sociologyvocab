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
// Agnes 国内节点（2026-07-29 上线；原 apihub.agnes-ai.com 为国际站，key/参数通用）
const AG_CHAT_URL = 'https://apihub.agnes-ai.cn/v1/chat/completions';

// ★ 2026-09-17 更换：原 `Qwen/Qwen3-235B-A22B` 已被魔搭下架（400 `has no provider supported`）。
// 这里是主站 /app-api/ai/complete 的「魔搭兜底档」——它排在 OpenRouter/Agnes 之后，只在免费档都失败时才烧魔粒。
const MS_MODEL = 'Qwen/Qwen3.5-122B-A10B';
// ★ 2026-09-21 换型：super-120b → **ultra-550b**。
//   实测（同一 prompt、同一数据、同一案例）：细粒度同义判断上 super 明显不足 ——
//   要素「认为男性同情心较少 / believes men have less sympathy」，学生写
//   "men are less able to empathize with others"：
//     super 判 0.0~0.5（不达标）✗   ultra 判 1.0 ✓   qwen3.8-27b 判 1.0 ✓   Qwen3.5-122B（魔搭）判 1.0 ✓
//   即「同义改写识别」是模型能力差异，不是 prompt 措辞问题（prompt 已明确要求近义词算覆盖）。
//   降级链不变：ultra → agnes（CF 出口被拒，实际常跳过）→ 魔搭。
const OR_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
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
    // ⚠️ 保持关推理 —— 这是**实测结论**，不是历史遗留：
    //   2026-09-21 用 16 个人工标注案例（同义改写/跨语言/方向相反）对 nemotron 做对照，
    //   关推理 3 轮全 16/16，开推理（reasoning.exclude）3 轮为 14~15/16 ——
    //   推理让模型更严格、爱逐子点核对（"未提长期失业""未提金钱"就压到 0.5），
    //   反而伤害了本任务最需要的"宽容同义改写"。
    //   详见 `定义题-判分实验与改进方向.md`。子站问答（长答、需深度推理）另走 worker.ts 的 exclude 档。
    //   注：关推理同样能规避当年那个「思考溢出」问题。
    body.reasoning = { enabled: false };
  } else if (tier === 'agnes') {
    url = AG_CHAT_URL; model = AG_MODEL; key = env.AGNES_API_KEY ?? '';
    body.model = model;
    // ★ 2026-09-21 加：强制 JSON 输出。实测（本地直连 .cn，判分用同一 prompt）：
    //   不加时 Agnes 会把 JSON 包在 ```json 围栏里（`parseJsonLoose` 虽能剥掉，但多一层脆性）；
    //   加上后返回**干净 JSON、无围栏无前言**，端到端解析成功率更稳。
    //   该参数被 Agnes 接受（不报 400），且不影响判分质量（同案例 coverage 判定一致）。
    // ⚠️ 无法关闭 Agnes 的推理：实测 `enable_thinking:false` 被忽略（reasoning_tokens 仍 140~255），
    //    推理与正文**共享 max_tokens 预算** —— 所以 maxTokens 必须留足（判分传 1000，实测占用 ~220~340，余量充足）。
    //    万一仍被截断，前端 `parseJsonLoose` 有截断补全兜底（且长度不符会判为解析失败、走重试/降级，不会错判）。
    body.response_format = { type: 'json_object' };
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
    let res = await callOnce(t, prompt, env, callOpts);
    // 免费池偶发「空内容 / 连接被断 / 5xx」：同档重试一次，再谈降级
    if (!res.ok && (res.detail === 'empty content' || res.status === 0 || res.status >= 500)) {
      res = await callOnce(t, prompt, env, callOpts);
    }
    // 空文本按失败处理：开推理后「推理吃光 max_tokens」会返回空 content（且 exclude 时连思考也看不到），
    // 不能当作成功返回，否则上层会拿到空判分结果 —— 继续走降级链。
    if (res.ok && res.text.trim()) {
      return { ok: true, text: res.text, model: res.model, tier: t, ms: Date.now() - t0, detail: '', fellBack: i > 0 };
    }
    if (res.ok) {
      console.error(`[ai/complete] ${t} returned empty text (likely reasoning ate the max_tokens budget)`);
    }
    console.error(`[ai/complete] ${t} failed: ${res.detail.slice(0, 120)}`);
    if (i === chain.length - 1) {
      return { ok: false, text: '', model: res.model, tier: 'none', ms: Date.now() - t0, detail: res.detail, fellBack: i > 0 };
    }
  }
  return { ok: false, text: '', model: '', tier: 'none', ms: Date.now() - t0, detail: 'no tiers', fellBack: false };
}
