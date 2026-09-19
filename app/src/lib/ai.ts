// 主站 AI 通路封装（POST /app-api/ai/complete）
//
// 与 components/OcrMarkPanel.tsx 里的调用方式保持一致：取 Supabase 会话 token → Bearer 鉴权；
// 非 200 或空文本一律抛出可读错误（detail / error / HTTP 状态），由调用方决定是否上浮。
//
// 判分口径（与 scripts/definition-grading-selftest.py 对齐）：
//   档位不由模型裁量，而是"模型判逐要素覆盖度 → 代码算档位"，保证可复现、可审计。
import { supabase } from './supabase';

export type AiTier = 'auto' | 'nemotron' | 'agnes' | 'ms';

export interface CompleteOpts {
  tier?: AiTier;
  maxTokens?: number;
  temperature?: number;
  system?: string;
  fallback?: boolean;   // 默认 false：单档失败即失败，便于观测真实可用性
}

export interface CompleteResult {
  text: string;
  model: string;
  tier: string;
  ms: number;
}

export async function callComplete(prompt: string, opts: CompleteOpts = {}): Promise<CompleteResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? '';
  if (!token) throw new Error('未登录');

  const res = await fetch('/app-api/ai/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt, ...opts }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    text?: string; model?: string; tier?: string; ms?: number; error?: string; detail?: string;
  };
  if (!res.ok || !body.text) {
    throw new Error(body.detail || body.error || `HTTP ${res.status}`);
  }
  return { text: body.text, model: body.model ?? '', tier: body.tier ?? '', ms: body.ms ?? 0 };
}

/** 从模型返回里抠出 JSON 对象：容忍 ``` 包裹、前后说明文字、尾随逗号 */
export function parseJsonLoose<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const blob = text
    .slice(start, end + 1)
    .replace(/```/g, '')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(blob) as T;
  } catch {
    return null;
  }
}

export type Verdict = 'correct' | 'partial' | 'wrong';

/**
 * 覆盖度 → 档位（确定性规则，与判分脚本一致）：
 *   correct：平均覆盖度 ≥ 0.75 且不是只罗列关键词
 *   partial：答到任一要素（对齐 ms 的"2 分/条"口径：答到一点给一点分）
 *   wrong  ：一个要素都没答到
 */
export function verdictFromCoverage(coverage: unknown, listingOnly: boolean): Verdict {
  const vals = (Array.isArray(coverage) ? coverage : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  if (!vals.length || Math.max(...vals) <= 0) return 'wrong';
  const score = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (score >= 0.75 && !listingOnly) return 'correct';
  return 'partial';
}

export interface GradeResult {
  verdict: Verdict;
  coverage: number[];
  listingOnly: boolean;
  reason: string;
  model: string;
  tier: string;
  ms: number;
}

/** 判一条定义默写作答：拼提示词 → 调模型 → 解析覆盖度 → 算档位 */
export async function gradeDefinition(
  term: string,
  keypoints: string[],
  answer: string,
  opts: CompleteOpts = {},
): Promise<GradeResult> {
  const list = keypoints.map((k, i) => `${i + 1}. ${k}`).join('\n');
  const prompt = `你是剑桥 9699 A Level 社会学的阅卷官。学生在做「术语定义默写」，请**只判定每个要素的覆盖程度**，不要给档位。

术语：${term}

核心要素（共 ${keypoints.length} 条）：
${list}

学生答案：${answer}

请对每个要素给出覆盖度 coverage：
- 1.0 = 该要素的意思表达到位（不要求用词一致、不要求逐点复述，意思到了即可）
- 0.5 = 只沾到一部分（说了半句、过于笼统、要靠猜才成立）
- 0.0 = 没提到，或说错

另外判断 listing_only：答案是否只是把关键词堆在一起、没有形成完整陈述（true/false）。
用中文或英文作答都算；意思相同即算覆盖，不要求用词一致。

只输出 JSON（不要 markdown、不要解释）：
{"coverage":[1.0,0.0],"listing_only":false,"reason":"不超过40字的中文理由","confidence":0.0}`;

  const { text, model, tier, ms } = await callComplete(prompt, { maxTokens: 600, ...opts });
  const parsed = parseJsonLoose<{ coverage?: unknown; listing_only?: boolean; reason?: string }>(text) ?? {};
  const listingOnly = Boolean(parsed.listing_only);
  const coverage = (Array.isArray(parsed.coverage) ? parsed.coverage : []).map((x) => Number(x));
  return {
    verdict: verdictFromCoverage(parsed.coverage, listingOnly),
    coverage,
    listingOnly,
    reason: String(parsed.reason ?? ''),
    model,
    tier,
    ms,
  };
}
