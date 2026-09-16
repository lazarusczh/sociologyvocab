// 主站 API 命名空间 /app-api/*（**登录即可**；学生向功能与教师向功能共用）
//
// 端点：
//   POST /app-api/ai/transcribe  视觉转写（OCR 辅助阅卷）
//   POST /app-api/ai/complete    通用文本补全（判分 / 要素抽取 / 批处理等）
//
// 鉴权口径（2026-09-15 调整）：① 必须登录；② 沿用 `ai_gate` 门禁（考试/论文期间学生被暂停，
// 教师与开发者始终放行）。**原先强制 teacher/developer 的规定已取消**——因为主站后续会有面向学生的
// AI 功能（作文批改、口语等）接入同一批模型。
//
// 与子站 /skill-api/* 的关系：**同一批模型、两套命名空间**，区别在档位策略、开关粒度与文案；
// 魔搭额度不分池（同一个账号，每日 ~250 魔粒）。

import { aiGateForbidden, bearer, verifyUser } from './ai/auth';
import { completeText, type TextTier } from './ai/text';
import { transcribePage } from './ai/vision';

export interface AppApiEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  MODELSCOPE_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AGNES_API_KEY?: string;
}

const MAX_PROMPT_CHARS = 24000; // 单次文本补全的提示词上限（约 8k tokens 量级）

// 与 worker.ts 的 CORS_ALLOWED 同源（待一次性抽取时合并到共享模块）
const CORS_ALLOWED = new Set([
  'https://9699vocab.cn',
  'https://www.9699vocab.cn',
  'https://sociologyvocab.zihaochen2096.workers.dev',
  'https://localhost',
  'capacitor://localhost',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8787',
]);

export function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allow = CORS_ALLOWED.has(origin) ? origin : 'https://9699vocab.cn';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'X-AI-Model',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (status: number, obj: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 单页上限（约 4.5MB 原图 → base64 后）

/** 返回 null 表示不是 /app-api/* 请求（交回主分发） */
export async function handleAppApi(request: Request, env: AppApiEnv, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/app-api/')) return null;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  const withCors = (res: Response) => {
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(request))) out.headers.set(k, v);
    return out;
  };

  // ---- 鉴权：登录即可（2026-09-15 调整，原先强制 teacher/developer）----
  // 原因：`/app-api/*` 是**主站**命名空间，后续面向学生的 AI 功能（作文批改、口语等）也要接入同一批模型，
  // 故改为与子站一致的口径：① 必须登录；② 沿用 `ai_gate` 门禁（考试/论文期间学生被暂停，教师与开发者始终放行）。
  // 安全边界：当前端点只做视觉转写、本身不读写数据库；学生答卷文本的可见性由 `ocr_pages` 的 RLS（仅本人）
  // 与「教师后台仅教师可见」共同把守。
  const token = bearer(request);
  if (!token) return withCors(json(401, { error: 'unauthorized' }));
  const userId = await verifyUser(token, env);
  if (!userId) return withCors(json(401, { error: 'invalid session' }));
  const gateNote = await aiGateForbidden(userId, token, env);
  if (gateNote) return withCors(json(403, { error: 'ai_paused', detail: gateNote }));

  // ---- POST /app-api/ai/transcribe ----
  if (url.pathname === '/app-api/ai/transcribe') {
    if (request.method !== 'POST') return withCors(json(405, { error: 'method not allowed' }));

    let body: { image?: string };
    try {
      body = (await request.json()) as { image?: string };
    } catch {
      return withCors(json(400, { error: 'bad json' }));
    }
    const image = body.image ?? '';
    if (!image) return withCors(json(400, { error: 'missing image' }));
    if (image.length > MAX_IMAGE_BYTES * 1.4) {
      return withCors(json(413, { error: 'image too large', detail: `上限约 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` }));
    }

    const res = await transcribePage(image, env);
    if (!res.ok) return withCors(json(res.status || 502, { error: 'transcribe failed', detail: res.detail.slice(0, 300) }));
    return withCors(
      json(200, { text: res.text, model: res.model, ms: res.ms, fellBack: res.fellBack }, { 'X-AI-Model': res.model }),
    );
  }

  // ---- POST /app-api/ai/complete ----（通用文本补全：判分 / 要素抽取 / 批处理等教师侧任务）
  // body: { prompt, tier?: auto|nemotron|agnes|ms, maxTokens?, temperature?, system?, fallback? }
  if (url.pathname === '/app-api/ai/complete') {
    if (request.method !== 'POST') return withCors(json(405, { error: 'method not allowed' }));

    let body: {
      prompt?: string; tier?: string; maxTokens?: number; temperature?: number;
      system?: string; fallback?: boolean;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return withCors(json(400, { error: 'bad json' }));
    }
    const prompt = body.prompt ?? '';
    if (!prompt) return withCors(json(400, { error: 'missing prompt' }));
    if (prompt.length > MAX_PROMPT_CHARS) {
      return withCors(json(413, { error: 'prompt too long', detail: `上限 ${MAX_PROMPT_CHARS} 字符` }));
    }
    const tier = (body.tier ?? 'auto') as TextTier | 'auto';
    if (!['auto', 'nemotron', 'agnes', 'ms'].includes(tier)) {
      return withCors(json(400, { error: 'bad tier', detail: 'auto | nemotron | agnes | ms' }));
    }

    const res = await completeText(prompt, tier, env, {
      maxTokens: body.maxTokens,
      temperature: body.temperature,
      system: body.system,
      fallback: body.fallback,
    });
    if (!res.ok) {
      return withCors(json(502, { error: 'complete failed', tier: res.tier, detail: res.detail.slice(0, 300) }));
    }
    return withCors(
      json(200, { text: res.text, model: res.model, tier: res.tier, ms: res.ms, fellBack: res.fellBack },
        { 'X-AI-Model': String(res.tier) }),
    );
  }

  return withCors(json(404, { error: 'not found' }));
}
