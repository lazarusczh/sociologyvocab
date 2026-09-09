// 问答 API 调用 + SSE 流式解析
import { supabase } from './supabase'

export interface AskResult {
  text: string;
  error: string | null;
  /** 本次应答所用模型档位标记（来自响应头 X-AI-Model），用于诊断/对比 */
  model?: string | null;
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
function askUrl(): string {
  const o = typeof location !== 'undefined' ? location.origin : '';
  const onSite = o.includes('9699vocab.cn') || o.includes('workers.dev');
  return onSite ? '/skill-api/ask' : `${REMOTE_ORIGIN}/skill-api/ask`;
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
  const fail = res.headers.get('X-AI-Fail');
  if (!ct.includes('text/event-stream')) {
    // 非流式兜底（如代理吞了流）
    const text = await res.text();
    return { text, error: null, model, fail };
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
  return { text: out, error: null, model, fail };
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
