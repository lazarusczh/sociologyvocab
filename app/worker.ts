// Cloudflare Worker：静态资源 + /wb/* 代理 + /skill-api/ask（教材 AI 问答）
// - /wb/*：转发到 https://api.worldbank.org/*（服务端转发，学生无需代理/无 CORS 问题）
// - /skill-api/ask：教材知识站问答（校验 Supabase 登录 JWT → Workers AI 流式生成）
// - 其余：由静态资产（ASSETS）提供

interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  MODELSCOPE_API_KEY?: string; // 魔搭免费 API key（经 secret put 注入，不落代码）
}

const WB_BASE = 'https://api.worldbank.org';
// 注意：若换模型需确保在 `npx wrangler ai models list` 中可用
const CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

// ===== ModelScope 魔粒多级路由 =====
// 免费策略：每日 ~250 魔粒；主流档 1 魔粒/次，旗舰档 2 魔粒/次（2026-09 口径）
const MS_URL = 'https://api-inference.modelscope.cn/v1/chat/completions';
// hybrid 模型：enable_thinking=false 走快速直答（日常主力），true 走思考链
const MS_MAIN = 'Qwen/Qwen3-235B-A22B';
// 独立思考模型（1 魔粒/次）：评估/AO3/对比题用，比 hybrid 思考版更新更强
const MS_THINK = 'Qwen/Qwen3-235B-A22B-Thinking-2507';
// 旗舰档（2 魔粒/次）：目前仅作预留，需要高质量顶格输出时再并入链
const MS_V4 = 'deepseek-ai/DeepSeek-V4-Flash-0731';

// 评估/对比类问题意图词（命中→思考模型）；日常直答模型只用于其余问题
const HARD_RE =
  /评估|评价|比较|对比|争议|批判|正反|优劣|优缺点|利弊|观点|同意|反对|AO3|assess|evaluate|compare|contrast|critic|strength|weakness|merit|limitation|advantage|disadvantage|judge|argue|debate/i;

// 校验 Supabase access token：调 auth/v1/user，返回用户 id；无效返回 null
async function verifyUser(token: string, env: Env): Promise<string | null> {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { id?: string };
    return body.id ?? null;
  } catch {
    return null;
  }
}

const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

// 允许调用 /skill-api/ask 的来源：官网、workers.dev 预览、本地 dev，
// 以及 APK（Capacitor 运行在 https://localhost，跨域调用需要 CORS）。
const CORS_ALLOWED = new Set([
  'https://9699vocab.cn',
  'https://www.9699vocab.cn',
  'https://sociologyvocab.zihaochen2096.workers.dev',
  'https://localhost',
  'capacitor://localhost',
  'http://localhost:5173',
  'http://localhost:5174',
]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allow = CORS_ALLOWED.has(origin) ? origin : 'https://9699vocab.cn';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// 教材知识站 AI 问答：POST { question, system, context }
async function handleAsk(request: Request, env: Env): Promise<Response> {
  // 1) 鉴权：仅登录用户可消耗 AI 额度（与版权 RLS 一致）
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!token) return json(401, { error: 'unauthorized' });
  const userId = await verifyUser(token, env);
  if (!userId) return json(401, { error: 'invalid session' });

  // 2) 读取请求体
  let body: { question?: string; system?: string; context?: string };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'bad json' });
  }
  const question = (body.question ?? '').trim();
  const system = (body.system ?? '').trim();
  const context = (body.context ?? '').trim();
  if (!question) return json(400, { error: 'missing question' });

  // 3) 组装 messages：system 注入答题人格；context 为前端检索出的教材段落（开卷材料）
  const messages: AiMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  const userContent = context
    ? `以下是从教材知识库检索到的相关材料（供作答依据）：\n\n${context}\n\n---\n\n学生提问：${question}\n\n请基于上述材料作答；材料没有覆盖的部分请明确说明「知识库未覆盖」，不要编造。作答要信息量充足、结构清晰（定义→机制→证据→需要时评价），概念与理论题请展开说明，不要只给一句释义或写成翻译。引用各书说法时行内注明书名即可，不要在正文额外列出「出处」清单——页面底部会单独展示出处。`
    : `学生提问：${question}`;
  messages.push({ role: 'user', content: userContent });

  // 4) 主链路：ModelScope（魔搭，免费魔粒）
  //    日常题 → Qwen3 hybrid 快速直答；评估/对比类 → Thinking-2507；任一失败自动降级
  const sseHeaders = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  } as const;
  const msKey = env.MODELSCOPE_API_KEY;
  if (msKey) {
    const hard = HARD_RE.test(question);
    if (hard) {
      const think = await msAsk(MS_THINK, messages, msKey, { maxTokens: 2400 });
      if (think) return new Response(think.body, { headers: sseHeaders });
    }
    const main = await msAsk(MS_MAIN, messages, msKey, { thinking: false, temperature: 0.6 });
    if (main) return new Response(main.body, { headers: sseHeaders });
  }

  // 5) 兜底：Workers AI（免费 neurons 额度内，成本趋零）
  try {
    const stream = await env.AI.run(CHAT_MODEL, {
      messages,
      stream: true,
      max_tokens: 1500,
      temperature: 0.8,
      top_p: 0.95,
    });
    return new Response(stream as unknown as ReadableStream, { headers: sseHeaders });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[skill-api/ask] ai error:', msg);
    return json(502, { error: 'ai error', detail: msg.slice(0, 300) });
  }
}

interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string }

// 调用 ModelScope（OpenAI 兼容）。非 200（429/限流/参数错）一律返回 null，交给调用链降级。
async function msAsk(
  model: string,
  messages: AiMessage[],
  key: string,
  opts: { thinking?: boolean; temperature?: number; maxTokens?: number } = {},
): Promise<Response | null> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    max_tokens: opts.maxTokens ?? 1500,
  };
  if (opts.thinking !== undefined) body.enable_thinking = opts.thinking;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  try {
    const r = await fetch(MS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error(`[msAsk ${model}] http ${r.status}: ${(await r.text()).slice(0, 160)}`);
      return null;
    }
    return r;
  } catch (e) {
    console.error('[msAsk] fetch error:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 教材知识站 AI 问答（APK 内 origin 是 https://localhost，需处理预检并回 CORS 头）
    if (url.pathname === '/skill-api/ask') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === 'POST') {
        const res = await handleAsk(request, env);
        const withCors = new Response(res.body, res);
        for (const [k, v] of Object.entries(corsHeaders(request))) withCors.headers.set(k, v);
        return withCors;
      }
      return json(405, { error: 'method not allowed' });
    }

    // 转发 World Bank 数据请求
    if (url.pathname.startsWith('/wb/')) {
      const target = WB_BASE + url.pathname.slice('/wb'.length) + url.search;
      try {
        const upstream = await fetch(target, { headers: { 'User-Agent': 'sociologyvocab/1.0' } });
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
            'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch {
        return json(502, { error: 'worldbank proxy failed' });
      }
    }

    // 其余请求：静态资源
    return env.ASSETS.fetch(request);
  },
};
