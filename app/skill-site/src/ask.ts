// 问答 API 调用 + SSE 流式解析
import { supabase } from './supabase'

export interface AskResult {
  text: string;
  error: string | null;
  /** 本次应答所用模型档位标记（来自响应头 X-AI-Model），用于诊断/对比 */
  model?: string | null;
  /**
   * 本次应答的**真实模型 id**（来自响应头 X-AI-Model-Id）。
   * 界面尾缀直接显示它，不必再维护「代号 → 名字」映射表 ——
   * 后端换模型时界面自动跟随（2026-09-17 修：原先前端写死的名字没跟上路由）。
   */
  modelId?: string | null;
  /** 落到兜底档时的降级原因（来自 X-AI-Fail，如 "agnes=429 ... | ms-main=401 ..."），仅诊断用 */
  fail?: string | null;
}

// 多轮上下文：模型要看到的最近几轮（user 提问原句 / assistant 纯回答）
export interface HistMsg {
  role: 'user' | 'assistant';
  content: string;
}

// APK 内页面运行在 Capacitor 的 https://localhost 下，相对路径只会打到本地 asset server，
// 到不了 Cloudflare Worker —— 非线上站点（原生壳 / 本地 dev）改用绝对地址。
const REMOTE_ORIGIN = 'https://9699vocab.cn';
function apiUrl(path: string): string {
  const o = typeof location !== 'undefined' ? location.origin : '';
  // 本地 dev（http://localhost:8787 / http://127.0.0.1:…）也算本站：
  // 否则本地预览会去打线上 API，改了后端也看不到效果。
  // 注意只认 http —— APK 的壳是 https://localhost，仍应走绝对地址。
  const localDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  const onSite = localDev || o.includes('9699vocab.cn') || o.includes('workers.dev');
  return onSite ? path : `${REMOTE_ORIGIN}${path}`;
}
const askUrl = () => apiUrl('/skill-api/ask');
const termsUrl = () => apiUrl('/skill-api/terms');

/**
 * 中文提问 → 英文检索词（页级索引只有英文关键词，纯中文问题否则零命中）。
 * 失败一律返回空数组，调用方静默降级为「只用原问题检索」。
 */
export async function fetchQueryTerms(question: string): Promise<string[]> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(termsUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { terms?: unknown };
    return Array.isArray(j.terms)
      ? j.terms.filter((x): x is string => typeof x === 'string').slice(0, 12)
      : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 联网检索（「第二段」）——设计见 知识库联网查询方案.md §2 / §11.2–11.4
//
// 分工是硬约束，不要合并：
//   资料库段 = 理论框架（原有问答，完全不变）
//   联网段   = 现实案例 / 过往研究（追加在资料库段之后，**独立一次调用**）
//
// 为什么分两次调用而不是一次：两段的**边界由请求本身决定**，模型没有机会自己决定
// "哪里开始联网"。代价是多一次模型调用（v1 已知取舍）。
// ---------------------------------------------------------------------------

export type SourceQuality = 'official' | 'academic' | 'media' | 'advocacy' | 'commercial' | 'blog';

export interface WebSource {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  quality: SourceQuality;
  region: string;
  primary: boolean;
  source?: string;
  year?: number;
  venue?: string;
  citedBy?: number;
  /** 作者姓氏（Tavily 侧通常没有） */
  authors?: string[];
}

export interface WebSearchPayload {
  sources: WebSource[];
  usedQuery?: string;
  error: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 检索外部材料。失败不抛异常，由调用方决定降级文案。
 * 对 5xx 与非 JSON 响应自动重试一次：本地 dev 重启后的首次请求偶发返回非 JSON
 * （2026-10-22 观察到），线上网络抖动同理。
 */
export async function searchWebRemote(
  question: string, terms: string[] = [], limit = 5,
): Promise<WebSearchPayload> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { sources: [], error: '登录已过期，请刷新后重试。' };

  let lastErr = '联网检索失败';
  for (let tries = 0; tries < 2; tries++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(apiUrl('/skill-api/web-search'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: question, terms, limit }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let msg = `检索失败（${res.status}）`;
        try {
          const j = (await res.json()) as { error?: string; detail?: string };
          if (j.error === 'ai_paused') msg = 'AI 功能已暂停，联网检索暂不可用。';
          else if (j.error === 'no_search_key') msg = '服务端未配置检索 key。';
          else msg = j.detail ?? j.error ?? msg;
        } catch { /* 非 JSON 错误体 */ }
        lastErr = msg;
        if (res.status >= 500 && tries === 0) { await sleep(600); continue; }
        return { sources: [], error: msg };
      }
      const text = await res.text();
      let j: { sources?: WebSource[]; usedQuery?: string; error?: string };
      try {
        j = JSON.parse(text) as typeof j;
      } catch {
        lastErr = '联网检索返回异常';
        if (tries === 0) { await sleep(600); continue; }
        return { sources: [], error: lastErr };
      }
      return { sources: Array.isArray(j.sources) ? j.sources : [], usedQuery: j.usedQuery, error: null };
    } catch {
      lastErr = '联网检索超时或网络失败';
      if (tries === 0) { await sleep(600); continue; }
      return { sources: [], error: lastErr };
    } finally {
      clearTimeout(timer);
    }
  }
  return { sources: [], error: lastErr };
}

// 联网段的 system：**只许用给定材料**（方案第四节红线），且不许替学生做方法论点评
const WEB_SEGMENT_SYSTEM = [
  '你现在只写「联网资料」这一段，作用是给教材语料补上它没有的现实案例与过往研究。',
  '硬规则：',
  '1. 只能使用给定的检索材料，**不得**补充你记忆里的其他案例、数字或研究；材料里没有的，就直说没有。',
  '2. 凡是用了某条材料，在句末标注编号，如 [1]；引用研究时写成「姓氏（年份）」的形式。',
  '3. 不要复述资料库段已经讲过的理论，只给增量：具体数据、具体研究、具体事件。',
  '4. 若材料与问题关系不大，直接写「本次检索未找到直接相关的材料」，不要硬凑。',
  '5. 材料可能来自其他国家；引用时必须写明是哪个国家/地区的数据，不要默认成英国。',
  '6. 300 字以内，条目式，不要写开场白。',
].join('\n');

export const QUALITY_CN: Record<string, string> = {
  official: '官方', academic: '学术', media: '媒体',
  advocacy: '倡导组织', commercial: '商业', blog: '博客',
};

/** 把检索结果编成模型可用的材料清单（编号与界面顺序一致） */
export function webSegmentPrompt(sources: WebSource[]): { system: string; context: string } {
  const lines = sources.map((s, i) => {
    const meta = [
      QUALITY_CN[s.quality] ?? s.quality,
      s.region,
      s.primary ? '原始' : '转述',
      s.year ? String(s.year) : '',
      s.venue ?? '',
    ].filter(Boolean).join(' · ');
    const who = s.authors?.length
      ? `作者：${s.authors.slice(0, 3).join(', ')}${s.authors.length > 3 ? ' et al.' : ''}\n`
      : '';
    return `[${i + 1}] ${s.title}\n${who}出处：${s.domain}（${meta}）\n${s.url}\n摘要：${s.snippet || '（无摘要）'}`;
  });
  return {
    system: WEB_SEGMENT_SYSTEM,
    context: `以下是本次联网检索到的材料（已按来源性质排序，编号供引用）：\n\n${lines.join('\n\n')}`,
  };
}

// 用 fetch 流式读取 SSE，逐块回调增量文本
export async function askStream(
  question: string,
  system: string,
  context: string,
  onDelta: (delta: string) => void,
  history: HistMsg[] = [],
  tier: string = 'auto',
  simulateStudent: boolean = false,
): Promise<AskResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { text: '', error: '登录已过期，请刷新后重试。' };

  // 超时保护：AI 冷启动可能较慢，但不应无限等待（否则界面一直停在"思考中"）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);

  let res: Response;
  try {
    res = await fetch(askUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question, system, context, history, tier, simulateStudent }),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    return { text: '', error: '网络请求失败，请检查网络后重试（APK 需联网访问 9699vocab.cn）。' };
  }
  clearTimeout(timer);

  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const j = (await res.json()) as { error?: string; detail?: string };
      if (j.error) msg = j.error === 'invalid session' ? '登录已失效，请返回词汇 App 重新登录。' : (j.detail ?? j.error);
    } catch { /* ignore */ }
    return { text: '', error: msg };
  }

  const ct = res.headers.get('Content-Type') ?? '';
  const model = res.headers.get('X-AI-Model');
  const modelId = res.headers.get('X-AI-Model-Id');
  const fail = res.headers.get('X-AI-Fail');
  if (!ct.includes('text/event-stream')) {
    // 非流式兜底（如代理吞了流）
    const text = await res.text();
    return { text, error: null, model, modelId, fail };
  }

  const reader = res.body?.getReader();
  if (!reader) return { text: '', error: '无法读取响应流。' };
  const decoder = new TextDecoder();
  let buffer = '';
  let out = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件可能跨 chunk，按 \n\n 切分
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          const piece = ssePiece(payload);
          if (piece) {
            out += piece;
            onDelta(piece);
          }
        }
      }
    }
  } catch {
    return { text: out, error: '网络中断，回答可能不完整。' };
  }

  // 流末尾兜底：最后一块可能不带 \n\n，直接按行再解析一次
  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const piece = ssePiece(payload);
    if (piece) {
      out += piece;
      onDelta(piece);
    }
  }
  return { text: out, error: null, model, modelId, fail };
}

/** 档位目录条目（GET /skill-api/models）——模型名的唯一真源在后端 */
export interface TierInfo {
  code: string;
  label: string;
  model: string;
  fallbacks?: string[];
  note?: string;
}

/** 拉取档位目录；失败返回空数组，调用方回退到内置清单 */
export async function fetchTierCatalog(): Promise<TierInfo[]> {
  const o = typeof location !== 'undefined' ? location.origin : '';
  const onSite = o.includes('9699vocab.cn') || o.includes('workers.dev');
  const url = onSite ? '/skill-api/models' : `${REMOTE_ORIGIN}/skill-api/models`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const j = (await res.json()) as { tiers?: TierInfo[] };
    return Array.isArray(j.tiers)
      ? j.tiers.filter((t) => t && typeof t.code === 'string' && typeof t.label === 'string')
      : [];
  } catch {
    return [];
  }
}

// 兼容多种上游的 SSE 负载：
// - ModelScope 自定义格式 data: { "response": "片段" }
// - OpenAI 标准流 data: { choices:[{ delta: { content } }] }
// 推理模型（如 Agnes）的 delta 会带 reasoning_content，这里刻意不取——
// 只透传 content，思考链天然不外泄。
function ssePiece(payload: string): string {
  try {
    const j = JSON.parse(payload) as {
      response?: string;
      choices?: { delta?: { content?: string; reasoning_content?: string } }[];
    };
    if (typeof j.response === 'string') return j.response;
    const d = j.choices?.[0]?.delta;
    if (d && typeof d.content === 'string') return d.content;
  } catch { /* 忽略非 JSON 行 */ }
  return '';
}
