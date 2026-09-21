// Cloudflare Worker：静态资源 + /wb/* 代理 + /skill-api/ask（教材 AI 问答）
// - /wb/*：转发到 https://api.worldbank.org/*（服务端转发，学生无需代理/无 CORS 问题）
// - /skill-api/ask：教材知识站问答（校验 Supabase 登录 JWT → Workers AI 流式生成）
// - /app-api/*：**主站 API（教师向，强制 teacher/developer）**，首个功能 = OCR 辅助阅卷
// - 其余：由静态资产（ASSETS）提供
//
// 命名空间约定（2026-09-13 定，详见 project-memory.md）：/skill-api/* = 子站（学生向）、
// /app-api/* = 主站（教师向）、/sb/* = Supabase 同源代理、/wb/* = World Bank 代理。
// 两套命名空间**共用同一批模型**（同一魔搭账号、每日 ~250 魔粒不分池），区别在鉴权级别/档位/开关。

import { handleAppApi } from './worker/appApi';
import { handleLabBrowser } from './worker/labBrowser';
import { handleMbApi } from './worker/mbApi';
import { aiGateForbidden, verifyUser } from './worker/ai/auth';

interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  MODELSCOPE_API_KEY?: string; // 魔搭免费 API key（经 secret put 注入，不落代码）
  OPENROUTER_API_KEY?: string; // OpenRouter key（:free 池，1000 次/日档；降级缓冲）
  AGNES_API_KEY?: string;       // Agnes AI key（apihub，免费；日常主力，省魔粒）
}

const WB_BASE = 'https://api.worldbank.org';
// 注意：若换模型需确保在 `npx wrangler ai models list` 中可用
const CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

// ===== ModelScope 魔粒多级路由 =====
// 免费策略：每日 ~250 魔粒；主流档 1 魔粒/次，旗舰档 2 魔粒/次（2026-09 口径）
const MS_URL = 'https://api-inference.modelscope.cn/v1/chat/completions';
// ★ 2026-09-17 更换模型 id：魔搭已下架整个 `Qwen/Qwen3-*` 系列 —— 调用一律返回
//   400 `Model id : ... , has no provider supported`，且它们都不在账号可见列表里
//   （魔搭换代成了 Qwen3.5）。下面三个 id 都是**当天实测可调用**的。
//   另外注意：魔搭免费池本身也不稳定（同批测试里会出现「HTTP 200 但 content 为空」），
//   所以多级降级链必须保留，不要因为单个模型可用就删掉后面的兜底。
// hybrid 模型：enable_thinking=false 走快速直答（日常主力）
const MS_MAIN = 'Qwen/Qwen3.5-122B-A10B';
// 独立思考模型：评估/AO3/对比题用，需要更强的推理能力。
// ★ 2026-09-17 选型时特意**不用第三方旗舰**（GLM-5.2 等通常按 2 魔粒计费，会让每日可用次数直接减半
//   —— 教师当天提醒了魔粒预算），改用同门最大号 Qwen3.5-397B：3 次连测全通，档位风险最低。
const MS_THINK = 'Qwen/Qwen3.5-397B-A17B';
// 注：原先这里还有个「旗舰档」常量 MS_V4（deepseek-ai/DeepSeek-V4.1-Flash），
// 但它从未接进任何调用分支 —— 2026-09-17 做 Worker 类型检查时暴露为死代码，故删除。
// 将来真要用，把常量、档位目录与调用分支一起加上。

// Agnes AI（apihub）：OpenAI 兼容；推理过程在独立字段 reasoning_content，
// 前端只取 content，思考链不外泄；质量经实测明显强于 8B（合格线达成）。
// 但从 Cloudflare Worker 出口直连实测恒被拒（CF WAF 1015 限流，与 key 无关，2026-09-09），
// 故默认不在 Worker 链上启用——仍可用于本地/个人 agent。日后若其风控调整，改回 true 即恢复。
const AGNES_VIA_CF = false;
const AG_URL = 'https://apihub.agnes-ai.com/v1/chat/completions';
const AG_MODEL = 'agnes-2.5-flash';

// OpenRouter（降级缓冲）：:free 池。gemma 系上游是 Google AI Studio 共享池，
// 高峰期几乎必 429（实测）；NVIDIA nemotron-super-120b 上游池宽松且稳定 200。
//
// ★ 2026-09-21 起改用 `reasoning: { enabled: true, exclude: true }`：
//   早年为避免「思考溢出到回答里」而直接关掉推理（reasoning.enabled=false），
//   但那同时也丢掉了推理带来的判断质量。OpenRouter 的 `exclude` 参数可以「照常推理、
//   但不返回思考内容」，于是两全：质量保留，思考不再外泄。
//   注意 max_tokens 是**推理 + 可见输出共享**的预算 → 开推理后必须调大（见 msAsk 默认值），
//   否则推理吃光预算会返回空 content。
// 若该 id 掉出免费池，再回退到其他 :free 通用模型。
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OR_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

// ---- 以下三块依赖上面的全部模型常量，必须放在它们之后 ----
//
// 教训（2026-09-17）：这三块原先放在文件顶部（MS_V4 之后），却引用了后面才定义的
// `OR_MODEL` 与函数内的 `sseHeaders` —— `const` 的暂时性死区 + 作用域错误让**每个请求**
// 都在模块加载时抛 ReferenceError，整站 500。而 `tsc -b` 抓不到，因为
// `tsconfig.app.json` 的 include 只有 `src`，**worker.ts 从来不在类型检查范围内**。
// ⇒ 改完 Worker 必须实际发一次请求验证（或让 tsc 覆盖 worker.ts）。

/** SSE 响应头（原先是 handleAsk 内的局部常量，提到模块级以便 aiHeaders 复用） */
const sseHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  'X-Accel-Buffering': 'no',
} as const;

/**
 * 档位目录 —— **模型名的唯一真源**。
 *
 * 前端（子站 AskView）据此渲染档位选择与回答尾缀，不再自己写一份模型名映射。
 * 这里直接引用上面的模型常量，所以以后换模型时界面会自动跟随，
 * 不会再出现「后端换了模型、界面还写着旧名」（2026-09-17 教师反馈快速档仍显示 Qwen3-235B）。
 * 经 GET /skill-api/models 暴露，纯只读、不含任何密钥。
 */
const AI_TIER_CATALOG = [
  { code: 'auto', label: '自动', model: '', fallbacks: [MS_MAIN, MS_THINK], note: '按题目难度自动选：日常走快速档，评估/对比类切深度档' },
  { code: 'fast', label: '快速', model: MS_MAIN, fallbacks: [], note: '强制快速档，不自动切深度' },
  { code: 'think', label: '深度', model: MS_THINK, fallbacks: [], note: '强制深度档，适合评估/对比类长答' },
  { code: 'nemotron', label: 'Nemo', model: OR_MODEL, fallbacks: [], note: 'OpenRouter 免费缓冲源（评测用）' },
  { code: 'llama', label: '兜底', model: CHAT_MODEL, fallbacks: [], note: 'Cloudflare Workers AI 兜底，成本趋零' },
];

/** 统一的 AI 响应头：档位代号 + **真实模型 id**（前端直接显示后者，不必再维护映射表） */
const aiHeaders = (code: string, modelId: string, extra: Record<string, string> = {}) => ({
  ...sseHeaders,
  'X-AI-Model': code,
  'X-AI-Model-Id': modelId,
  ...extra,
});

// 评估/对比类问题意图词（命中→思考模型）；日常直答模型只用于其余问题
const HARD_RE =
  /评估|评价|比较|对比|争议|批判|正反|优劣|优缺点|利弊|观点|同意|反对|AO3|assess|evaluate|compare|contrast|critic|strength|weakness|merit|limitation|advantage|disadvantage|judge|argue|debate/i;

// 临时验证开关（已实证 nemotron 线上跑通，2026-09-09）：true 时跳过魔搭双档走降级链。
// 平时必须为 false。
const MS_TEST_SKIP = false;

// 注：verifyUser / rolesOf / isTeacherOrDeveloper / aiGateForbidden 均已抽到 worker/ai/auth.ts，
// 本文件改为 import（逻辑与原先完全一致）；主站 /app-api/* 复用同一份，两套命名空间不再各写一遍。

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
    // 让跨域客户端（APK/dev）能读到模型档位与降级原因标记
    'Access-Control-Expose-Headers': 'X-AI-Model, X-AI-Model-Id, X-AI-Fail',
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

  // 2) 读取请求体（提前解析，门禁的 simulateStudent 标志来自 body）
  let body: {
    question?: string;
    system?: string;
    context?: string;
    history?: { role?: string; content?: string }[];
    simulateStudent?: boolean; // 教师/开发者自测用：把自己的请求按学生身份判定门禁
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'bad json' });
  }
  const question = (body.question ?? '').trim();
  const system = (body.system ?? '').trim();
  const context = (body.context ?? '').trim();
  if (!question) return json(400, { error: 'missing question' });

  // 1b) AI 门禁：教师临时关闭期间仅 teacher/developer 可用（防论文/考试作弊）。
  //     simulateStudent=true 时跳过角色豁免，让教师/开发者自测"学生被拦"的效果。
  const gateNote = await aiGateForbidden(userId, token, env, body.simulateStudent === true);
  if (gateNote) return json(403, { error: 'ai_paused', detail: gateNote });

  // 3) 组装 messages：system → 多轮历史 → 当前轮（带检索材料）
  const messages: AiMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  // 历史轮做防御性清洗：角色白名单、单条去空白/限长、总量限条数，
  // 避免客户端异常或恶意超长 history 撑爆请求体 / 浪费上下文
  const MAX_HISTORY_MSGS = 12;
  const MAX_HISTORY_MSG_LEN = 4000;
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  for (const h of rawHistory) {
    if (messages.length - (system ? 1 : 0) >= MAX_HISTORY_MSGS) break;
    const role = h.role === 'user' || h.role === 'assistant' ? h.role : null;
    if (!role) continue;
    let content = (h.content ?? '').trim();
    if (!content) continue;
    if (content.length > MAX_HISTORY_MSG_LEN) content = content.slice(-MAX_HISTORY_MSG_LEN);
    messages.push({ role, content });
  }
  // 多数兼容端点要求首条为 system 或 user：若清洗后首条是 assistant 则丢弃
  while (messages.length > (system ? 1 : 0) && messages[system ? 1 : 0].role === 'assistant') {
    messages.splice(system ? 1 : 0, 1);
  }
  const hasHistory = Array.isArray(body.history) && body.history.length > 0;
  const followNote = hasHistory
    ? '这是同一段对话里的追问：此前已给出的定义、机制与论据都视为已建立的上下文，不要整段复述或原样重排（确需回指时最多用一句「如前所述」带过），把篇幅留给本次提问真正需要的增量。\n\n'
    : '';
  const userContent = context
    ? `${followNote}以下是从教材知识库检索到的相关材料（供作答依据）：\n\n${context}\n\n---\n\n学生提问：${question}\n\n请基于上述材料作答；材料没有覆盖的部分请明确说明「知识库未覆盖」，不要编造。作答要信息量充足、结构清晰（定义→机制→证据→需要时评价），概念与理论题请展开说明，不要只给一句释义或写成翻译。引用各书说法时行内注明书名即可，不要在正文额外列出「出处」清单——页面底部会单独展示出处。`
    : `${followNote}学生提问：${question}`;
  messages.push({ role: 'user', content: userContent });

  // 4) 多级路由：
  //    评估/对比类 → 魔搭 Qwen3 Thinking（1 魔粒，深度已被长期验证）
  //    其余日常    → Agnes-2.5-flash（免费，不烧魔粒；推理链前端剥离）
  //    逐级失败降级：魔搭快速档 → OpenRouter nemotron(:free 开推理 + exclude) → Workers 8B
  // sseHeaders 已提到模块级（见文件上方），这里直接用，不再重复定义
  const msKey = env.MODELSCOPE_API_KEY;
  const agKey = env.AGNES_API_KEY;
  const orKey = env.OPENROUTER_API_KEY;
  const hard = HARD_RE.test(question);

  // 降级原因收集：落到兜底档时经 X-AI-Fail 响应头回传，前端可显示以便诊断
  const failLog: string[] = [];
  const rec =
    (name: string) =>
    (status: number, snippet: string) =>
      failLog.push(`${name}=${status} ${snippet.replace(/\s+/g, ' ').slice(0, 90)}`);

  // 4x) 手动指定档位（模拟 agent 的模型选择）：成功即返回，失败回落自动链。
  //     前端传 body.tier：auto(默认自动路由) / fast / think / nemotron / llama
  const tier = String((body as { tier?: unknown }).tier ?? 'auto').trim();
  if (msKey && tier === 'fast') {
    const main = await msAsk(MS_MAIN, messages, msKey, { thinking: false, temperature: 0.6, onFail: rec('ms-main') });
    if (main) return new Response(main.body, { headers: aiHeaders('qwen3-main', MS_MAIN) });
  }
  if (msKey && tier === 'think') {
    const think = await msAsk(MS_THINK, messages, msKey, { maxTokens: 2400, onFail: rec('ms-think') });
    if (think) return new Response(think.body, { headers: aiHeaders('qwen3-think', MS_THINK) });
  }
  if (orKey && tier === 'nemotron') {
    const orRes = await msAsk(OR_MODEL, messages, orKey, {
      temperature: 0.6,
      reasoning: 'exclude',   // 开推理但不回传思考内容（前端只取 content，双保险）
      base: OR_URL,
      extraHeaders: { 'HTTP-Referer': 'https://9699vocab.cn', 'X-Title': '9699-sociology-skill' },
      onFail: rec('or-nemotron'),
    });
    if (orRes) return new Response(orRes.body, { headers: aiHeaders('openrouter', OR_MODEL) });
  }
  // 手动选 llama = 直接走 Workers 8B；其它手动档失败仍走下方自动链兜底
  const skipAuto = tier === 'llama';

  // 4a) 评估/复杂题：魔搭 Thinking 优先
  if (hard && msKey && !MS_TEST_SKIP && !skipAuto) {
    const think = await msAsk(MS_THINK, messages, msKey, { maxTokens: 2400, onFail: rec('ms-think') });
    if (think) return new Response(think.body, { headers: aiHeaders('qwen3-think', MS_THINK) });
  }

  // 4b) 日常主力：Agnes（免费，省魔粒）——因 CF 出口 1015 限流默认关闭（AGNES_VIA_CF=false）
  if (AGNES_VIA_CF && agKey) {
    const ag = await msAsk(AG_MODEL, messages, agKey, { base: AG_URL, maxTokens: 1800, onFail: rec('agnes') });
    if (ag) return new Response(ag.body, { headers: aiHeaders('agnes', AG_MODEL) });
  }

  // 4c) 降级①：魔搭快速档（Agnes 不可用 / 评估题 think 已失败时顶上）
  if (msKey && !MS_TEST_SKIP && !skipAuto) {
    const main = await msAsk(MS_MAIN, messages, msKey, { thinking: false, temperature: 0.6, onFail: rec('ms-main') });
    if (main) return new Response(main.body, { headers: aiHeaders('qwen3-main', MS_MAIN) });
  }

  // 4d) 降级②：OpenRouter :free（nemotron，开推理但不回传思考内容）
  if (orKey && !skipAuto) {
    const orRes = await msAsk(OR_MODEL, messages, orKey, {
      temperature: 0.6,
      reasoning: 'exclude', // 思考链不回传：既保留推理质量，又不会溢出到回答里
      base: OR_URL,
      extraHeaders: { 'HTTP-Referer': 'https://9699vocab.cn', 'X-Title': '9699-sociology-skill' },
      onFail: rec('or-nemotron'),
    });
    if (orRes) return new Response(orRes.body, { headers: aiHeaders('openrouter', OR_MODEL) });
  }

  // 5) 兜底：Workers AI（免费 neurons 额度内，成本趋零）
  try {
    const stream = await env.AI.run(CHAT_MODEL, {
      messages: shrinkForLlama(messages),
      stream: true,
      max_tokens: 1500,
      temperature: 0.8,
      top_p: 0.95,
    });
    return new Response(stream as unknown as ReadableStream, {
      headers: aiHeaders('workers-8b', CHAT_MODEL, failLog.length ? { 'X-AI-Fail': failLog.join(' | ') } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[skill-api/ask] ai error:', msg);
    return json(502, { error: 'ai error', detail: msg.slice(0, 300) });
  }
}

// 中文提问 → 英文检索词：教材原文页索引的关键词是英文，纯中文问题会零命中。
// 用 Workers AI（免费额度、无需外部 key）把问题译成社会学英文术语，作为补充检索词；
// 失败或纯英文提问都返回空数组，前端静默降级为「只按原问题检索」。
async function handleTerms(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!token) return json(401, { error: 'unauthorized' });
  const userId = await verifyUser(token, env);
  if (!userId) return json(401, { error: 'invalid session' });

  let body: { question?: string };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'bad json' });
  }
  const question = (body.question ?? '').trim();
  if (!question) return json(400, { error: 'missing question' });
  // 纯英文提问不需要翻译，避免浪费一次调用
  if (!/[\u4e00-\u9fff]/.test(question)) return json(200, { terms: [] });

  const sys =
    'You translate A-level sociology questions into English search keywords. ' +
    'Output ONLY a comma-separated list of 8-12 English keywords: sociological terms, concepts, ' +
    'and theorist surnames that would appear in a textbook. No explanation, no Chinese, no numbers.';
  try {
    const r = (await env.AI.run(CHAT_MODEL, {
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: question },
      ],
      max_tokens: 120,
      temperature: 0.1,
    })) as { response?: string };
    const raw = (r?.response ?? '').replace(/\n/g, ' ');
    const terms = [
      ...new Set(
        raw
          .split(/[,，;；\s]+/)
          .map((s) => s.replace(/[^\w'&-]/g, '').trim().toLowerCase())
          .filter((s) => s.length >= 3),
      ),
    ].slice(0, 12);
    return json(200, { terms });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[skill-api/terms] ai error:', msg);
    return json(200, { terms: [] });
  }
}

interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string }

// 兜底档（Workers 8B）容量小、对长指令的服从性弱，单独降配：
// 1) 裁剪检索材料——前端组装时材料已按相关度排序，砍尾部（保留末尾提问）；
// 2) 追加「要点式简答」以覆盖 system 里面向大模型的「展开 300–500 字」要求，
//    避免弱模型撑不出长答案就编造。
const LLAMA_CONTEXT_CHAR = 8000;
const LLAMA_TAIL_NOTE =
  '\n\n【兜底档专用】若上文要求展开到 300–500 字，本档改为要点式简答：' +
  '先给定义或结论，再列 3–5 条带证据的要点，最后一句平衡结论；材料未覆盖处直接说明，不要编造。';

function shrinkForLlama(messages: AiMessage[]): AiMessage[] {
  return messages.map((m) => {
    if (m.role === 'system') return { role: 'system', content: m.content + LLAMA_TAIL_NOTE };
    if (m.role !== 'user' || m.content.length <= LLAMA_CONTEXT_CHAR) return m;
    const content = m.content;
    const qi = content.indexOf('学生提问：');
    if (qi === -1) return { role: 'user', content: content.slice(0, LLAMA_CONTEXT_CHAR) + '…' };

    const head = content.slice(0, qi);   // 材料区：导语 + 蒸馏材料 + 教材原文页
    const tail = content.slice(qi);      // 提问与作答要求，必须原样保留
    const budget = Math.max(0, LLAMA_CONTEXT_CHAR - tail.length);
    const parts = head.split('\n\n---\n\n');
    // 原文页块以「【…p.123…】」开头——细节最具体，弱模型兜底时优先保留
    const isPage = (p: string) => /^【[^】]*p\.\d+/.test(p.trim());
    const pageParts = parts.filter(isPage);
    const otherParts = parts.filter((p) => !isPage(p));

    let used = 0;
    const keptOther: string[] = [];
    for (const p of otherParts) {
      if (keptOther.length >= 2) break;                  // 蒸馏材料留前两块做考点/结构提示
      if (used + p.length > budget) break;
      keptOther.push(p);
      used += p.length;
    }
    const keptPage: string[] = [];
    for (let i = pageParts.length - 1; i >= 0; i--) {     // 页块从后往前收（离提问近的先留）
      const p = pageParts[i];
      if (used + p.length > budget) continue;
      keptPage.unshift(p);
      used += p.length;
    }
    const merged = [...keptOther, ...keptPage].join('\n\n---\n\n');
    return {
      role: 'user',
      content: `${merged}\n\n（材料已按兜底档容量裁剪）\n\n${tail}`,
    };
  });
}

// 调用 OpenAI 兼容端点（ModelScope / OpenRouter 通用）。非 200（429/限流/参数错）一律返回 null。
async function msAsk(
  model: string,
  messages: AiMessage[],
  key: string,
  opts: {
    thinking?: boolean;
    /**
     * OpenRouter 推理模型开关：
     *   false     = 关思考，只输出答案
     *   true      = 开思考（思考内容会出现在 reasoning 字段，可能被日志/前端看到）
     *   'exclude' = **开思考但不返回思考内容**（OpenRouter 的 reasoning.exclude）——
     *               两全其美：保留推理带来的质量，又不让思考链外泄或溢出到可见输出。
     */
    reasoning?: boolean | 'exclude';
    temperature?: number;
    maxTokens?: number;
    base?: string; // 默认 ModelScope；传 OR_URL 即走 OpenRouter
    extraHeaders?: Record<string, string>;
    onFail?: (status: number, snippet: string) => void; // 失败时回调，供上层收集降级原因
  } = {},
): Promise<Response | null> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    // 推理与可见输出**共享**这份预算：nemotron 开推理（exclude）后要留足思考空间，
    // 否则思考吃光预算会返回空内容（OpenRouter 文档明确提醒的坑）。
    max_tokens: opts.maxTokens ?? 3600,
  };
  if (opts.thinking !== undefined) body.enable_thinking = opts.thinking;
  if (opts.reasoning !== undefined) {
    body.reasoning = opts.reasoning === 'exclude'
      ? { enabled: true, exclude: true }
      : { enabled: opts.reasoning };
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  try {
    const r = await fetch(opts.base ?? MS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        // 免费 API 常校验 UA：不带浏览器 UA 的数据中心请求可能被直接拒绝（本地 node 测试自带 UA 故成功）
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        ...opts.extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const snippet = (await r.text()).slice(0, 160);
      console.error(`[msAsk ${model}] http ${r.status}: ${snippet}`);
      opts.onFail?.(r.status, snippet);
      return null;
    }
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[msAsk] fetch error:', msg);
    opts.onFail?.(0, `fetch ${msg}`);
    return null;
  }
}

// ===== Supabase 同源代理 /sb/*（前端"直连失败自动回退"的目标，详见 KNOWN_ISSUES 第 4 条）=====
// 为什么需要：部分设备（信任库较旧的 Android）不信任 Supabase 主机证书（链根是较新的
// GlobalSign Root R46）——浏览器可手动"继续访问"，WebView 不能，于是登录/同步全部 Failed to fetch。
// 由 Worker 直连 Supabase 代发请求后，客户端只需与 9699vocab.cn 通信，证书问题消失。
// 安全约束：① 只放行 auth / rest 两个前缀（防止被当成开放代理）；② 方法限白名单；
//           ③ apikey 由服务端注入（客户端不必携带，也无法伪造别的 key）。
const SB_PREFIXES = ['/auth/v1/', '/rest/v1/'];
const SB_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
// 只转发客户端真正需要的请求头，其余一律丢弃（避免意外透传敏感头）
const SB_FORWARD_HEADERS = ['authorization', 'content-type', 'accept', 'prefer', 'range', 'x-client-info'];
// 这两个头不能原样回传：Workers 的 fetch 会把上游 body 自动解压，原样带上会导致客户端解析失败
const SB_DROP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

function sbCorsHeaders(request: Request): Record<string, string> {
  // 代理是给自家客户端（网页 / APK / 本地 dev）用的：**回显请求的 Origin**、不回显白名单。
  // 安全性不受影响——anon key 本就是公开密钥，数据可见性由 Supabase 的 RLS 决定，
  // 这与"任何网站直接拿该 anon key 调 Supabase"完全等价。必须回显的原因：APK 的 origin 是
  // `https://localhost`、本地 dev 是 `http://localhost:5173`，白名单方式极易漏掉某个来源，
  // 而一旦漏掉，客户端就是 Failed to fetch（且 curl 不走 CORS 预检，测不出来）。
  const origin = request.headers.get('Origin') ?? 'https://9699vocab.cn';
  // 同理回显预检声明的请求头：supabase-js 不同版本会带不同头（如 `x-supabase-api-version`），
  // 写死列表会漏 → 预检失败。转发时我们只挑白名单头给 Supabase，多声明的头不会真正透传。
  const reqHeaders = (request.headers.get('Access-Control-Request-Headers') ?? '').trim();
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      reqHeaders || 'apikey, authorization, content-type, accept, prefer, range, x-client-info',
    // 让跨域客户端也能读到计数/分页相关的响应头（否则 count 查询在 APK 里读到 null）
    'Access-Control-Expose-Headers': 'content-range, content-profile, x-supabase-api-version, prefer',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function handleSbProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice('/sb'.length); // 保留 /auth/v1/... 原样
  const headers = new Headers();
  for (const h of SB_FORWARD_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('apikey', env.SUPABASE_ANON_KEY);
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  try {
    const upstream = await fetch(`${env.SUPABASE_URL}${path}${url.search}`, init);
    const outHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      if (!SB_DROP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders.set(k, v);
    }
    for (const [k, v] of Object.entries(sbCorsHeaders(request))) outHeaders.set(k, v);
    // ⚠️ 绝不能进 CDN 缓存：Cloudflare 的边缘缓存**按 URL 分键、不看 Authorization**。
    // 若缓存了带鉴权的响应，就可能把 A 用户的查询结果发给 B 用户（隐私事故）；
    // 也会让登录后的数据读到陈旧副本。故一律显式禁缓存（同时覆盖上游可能带的缓存头）。
    outHeaders.set('Cache-Control', 'no-store, private');
    outHeaders.set('CDN-Cache-Control', 'no-store');
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sb] proxy error:', msg);
    return json(502, { error: 'sb proxy failed', detail: msg.slice(0, 200) });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 档位目录（模型名的唯一真源）：子站前端据此渲染档位选择与回答尾缀。
    // 纯只读、不含密钥，故不要求登录；回 CORS 头供子站/APK 跨域读取。
    if (url.pathname === '/skill-api/models') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      const res = json(200, { tiers: AI_TIER_CATALOG });
      for (const [k, v] of Object.entries(corsHeaders(request))) res.headers.set(k, v);
      return res;
    }

    // 教材知识站 AI 问答（APK 内 origin 是 https://localhost，需处理预检并回 CORS 头）
    if (url.pathname === '/skill-api/ask' || url.pathname === '/skill-api/terms') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      if (request.method === 'POST') {
        const res =
          url.pathname === '/skill-api/terms'
            ? await handleTerms(request, env)
            : await handleAsk(request, env);
        const withCors = new Response(res.body, res);
        for (const [k, v] of Object.entries(corsHeaders(request))) withCors.headers.set(k, v);
        return withCors;
      }
      return json(405, { error: 'method not allowed' });
    }

    // 实验路由（Browser Run 验证）：/app-api/lab/* —— 令牌门禁 + 目标白名单，详见 worker/labBrowser.ts
    const labRes = await handleLabBrowser(request, env as never, url);
    if (labRes) return labRes;

    // ManageBac 同步（教师专用，只读抓取）：/app-api/mb/* —— 详见 worker/mbApi.ts
    // 必须在 handleAppApi 之前：后者会接管整个 /app-api/ 前缀
    const mbRes = await handleMbApi(request, env as never, url);
    if (mbRes) return mbRes;

    // 主站 API：/app-api/* —— 详见 worker/appApi.ts
    const appApiRes = await handleAppApi(request, env, url);
    if (appApiRes) return appApiRes;

    // Supabase 同源代理（前端直连失败后的回退通道）
    if (url.pathname === '/sb' || url.pathname.startsWith('/sb/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: sbCorsHeaders(request) });
      }
      if (!SB_METHODS.has(request.method)) return json(405, { error: 'method not allowed' });
      const sub = url.pathname.slice('/sb'.length);
      if (!SB_PREFIXES.some((p) => sub.startsWith(p))) return json(403, { error: 'path not allowed' });
      return handleSbProxy(request, env);
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
