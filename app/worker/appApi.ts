// 主站 API 命名空间 /app-api/*（教师向，强制 teacher/developer 鉴权）
//
// 首个功能：OCR 辅助阅卷 —— POST /app-api/ai/transcribe
//   body: { image: "data:image/png;base64,..." }   （单页一次，前端逐页并发/串行调用）
//   返回: { text, model, ms }
//
// 与子站 /skill-api/* 的关系：**同一批模型、两套命名空间**。区别在鉴权级别（这里必须教师）、
// 档位策略、开关粒度与文案；魔搭额度不分池（同一个账号，每日 ~250 魔粒）。

import { bearer, isTeacherOrDeveloper, verifyUser } from './ai/auth';
import { transcribePage } from './ai/vision';

export interface AppApiEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  MODELSCOPE_API_KEY?: string;
}

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

function cors(request: Request): Record<string, string> {
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

  // ---- 鉴权：必须登录 + 必须 teacher/developer ----
  const token = bearer(request);
  if (!token) return withCors(json(401, { error: 'unauthorized' }));
  const userId = await verifyUser(token, env);
  if (!userId) return withCors(json(401, { error: 'invalid session' }));
  if (!(await isTeacherOrDeveloper(userId, token, env))) {
    return withCors(json(403, { error: 'teacher_only', detail: '仅教师/开发者可用' }));
  }

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

  return withCors(json(404, { error: 'not found' }));
}
