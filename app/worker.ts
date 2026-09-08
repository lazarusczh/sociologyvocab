// Cloudflare Worker：静态资源 + /wb/* 代理 + /skill-api/ask（教材 AI 问答）
// - /wb/*：转发到 https://api.worldbank.org/*（服务端转发，学生无需代理/无 CORS 问题）
// - /skill-api/ask：教材知识站问答（校验 Supabase 登录 JWT → Workers AI 流式生成）
// - 其余：由静态资产（ASSETS）提供

interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

const WB_BASE = 'https://api.worldbank.org';
// 注意：若换模型需确保在 `npx wrangler ai models list` 中可用
const CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

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
    ? `以下是从教材知识库检索到的相关材料（供作答依据）：\n\n${context}\n\n---\n\n学生提问：${question}\n\n请基于上述材料作答；材料没有覆盖的部分请明确说明「知识库未覆盖」，不要编造。回答尽量精炼、分点、便于 A Level 学生理解，并在回答末尾用「出处」列出你引用的章节/术语。`
    : `学生提问：${question}`;
  messages.push({ role: 'user', content: userContent });

  // 4) 流式调用 Workers AI（qwen3，MoE 低成本高中文质量）
  try {
    const stream = await env.AI.run(CHAT_MODEL, {
      messages,
      stream: true,
      max_tokens: 900,
    });
    return new Response(stream as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[skill-api/ask] ai error:', msg);
    return json(502, { error: 'ai error', detail: msg.slice(0, 300) });
  }
}

interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string }

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
