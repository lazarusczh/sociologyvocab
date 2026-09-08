// 问答 API 调用 + SSE 流式解析
import { supabase } from './supabase'

export interface AskResult {
  text: string;
  error: string | null;
}

// 用 fetch 流式读取 SSE，逐块回调增量文本
export async function askStream(
  question: string,
  system: string,
  context: string,
  onDelta: (delta: string) => void,
): Promise<AskResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { text: '', error: '登录已过期，请刷新后重试。' };

  const res = await fetch('/skill-api/ask', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question, system, context }),
  });

  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const j = (await res.json()) as { error?: string; detail?: string };
      if (j.error) msg = j.error === 'invalid session' ? '登录已失效，请返回词汇 App 重新登录。' : (j.detail ?? j.error);
    } catch { /* ignore */ }
    return { text: '', error: msg };
  }

  const ct = res.headers.get('Content-Type') ?? '';
  if (!ct.includes('text/event-stream')) {
    // 非流式兜底（如代理吞了流）
    const text = await res.text();
    return { text, error: null };
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
          try {
            const j = JSON.parse(payload) as { response?: string };
            if (typeof j.response === 'string') {
              out += j.response;
              onDelta(j.response);
            }
          } catch { /* 忽略非 JSON 行 */ }
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
    try {
      const j = JSON.parse(payload) as { response?: string };
      if (typeof j.response === 'string') {
        out += j.response;
        onDelta(j.response);
      }
    } catch { /* 忽略 */ }
  }
  return { text: out, error: null };
}
