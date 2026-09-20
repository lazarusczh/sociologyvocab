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

  // 免费池偶发空响应/瞬时错误：客户端再试一次，避免学生看到一次失败就得手动重提
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('/app-api/ai/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt, ...opts }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        text?: string; model?: string; tier?: string; ms?: number; error?: string; detail?: string;
      };
      if (res.ok && body.text) {
        return { text: body.text, model: body.model ?? '', tier: body.tier ?? '', ms: body.ms ?? 0 };
      }
      lastErr = body.detail || body.error || `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr || '判分失败，请重试');
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
 * 覆盖度 → 档位（确定性规则，与判分脚本一致）。
 *
 * 门槛随「要素条数」递减：条数多的术语几乎都是**并列列举型**
 * （如 toxic childhood 的七项危害、Wealth 的五种形式），要求答全不现实；
 * 教学上"举出其中若干项"即算掌握。
 *   ≤3 条（递进必需型）：≥ 0.75
 *   4–5 条：              ≥ 0.5
 *   ≥6 条：               ≥ 0.4（七项答中 3 项即通关，对应"for example 举 2–3 项"）
 * partial：答到任一要素（对齐 ms 的"2 分/条"口径：答到一点给一点分）
 * wrong  ：一个要素都没答到
 */
export function correctThreshold(kpCount: number): number {
  if (kpCount >= 6) return 0.4;
  if (kpCount >= 4) return 0.5;
  return 0.75;
}

export function verdictFromCoverage(coverage: unknown, listingOnly: boolean, kpCount = 0): Verdict {
  const vals = (Array.isArray(coverage) ? coverage : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  if (!vals.length || Math.max(...vals) <= 0) return 'wrong';
  const score = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (score >= correctThreshold(kpCount || vals.length) && !listingOnly) return 'correct';
  return 'partial';
}

// ===== 逐要素性质的判分（2026-09-20 起采用）=====
// 要素分两类，判分口径不同：
//   required（定义主干）—— 必须答到，平均覆盖度 ≥ 0.75
//   example （并列举例）—— 举出其中若干项即可：≤2 项时答 1 项、≥3 项时答 2 项
// 例：green crime = [必须] 危害环境的全球性犯罪 + 举例(倾倒/开采/污染) → 答出定义 + 举 2 例即通关。
export interface KeypointRef {
  text: string;
  kind?: 'required' | 'example';
}

export function verdictFromKeypoints(coverage: unknown, kps: KeypointRef[], listingOnly: boolean): Verdict {
  const vals = (Array.isArray(coverage) ? coverage : []).map((x) => Number(x));
  if (!vals.length || Math.max(...vals) <= 0) return 'wrong';

  const reqIdx: number[] = [];
  const exIdx: number[] = [];
  kps.forEach((k, i) => (k.kind === 'example' ? exIdx : reqIdx).push(i));

  const reqScore = reqIdx.length
    ? reqIdx.reduce((s, i) => s + (vals[i] ?? 0), 0) / reqIdx.length
    : 1;                                                  // 无主干要素（纯列举型）时不设约束
  // 主干要素必须「每一项都答到位」：平均达标不够（两条主干只答一条、另一条蒙对半个，不应算掌握）
  const reqAllOk = reqIdx.every((i) => (vals[i] ?? 0) >= 0.75);
  // 举例项要"确实举到"才算命中（0.5 表示只沾到一点/概括带过，不能算）
  const exHits = exIdx.filter((i) => (vals[i] ?? 0) >= 0.75).length;
  const exNeed = exIdx.length ? (exIdx.length <= 2 ? 1 : 2) : 0;

  if (reqAllOk && exHits >= exNeed && !listingOnly) return 'correct';
  if (reqScore >= 0.3 || exHits >= 1) return 'partial';
  return 'wrong';
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

// 来源标签（写进判分提示词，让模型知道参照原文的出处）
const SOURCE_LABEL: Record<string, string> = {
  main: '主站词库（学生日常练习所依据的定义）',
  tb1: '教材 Haralambos',
  tb2: '教材 Livesey Coursebook',
  igcse0495: '0495 官方 glossary',
};

/** 判一条定义默写作答：拼提示词 → 调模型 → 解析覆盖度 → 算档位。
 *
 *  sourceDefs = 各来源的**英文原文**。学生多用英文作答，而同语言比对能避免
 *  「英文原文 → 中文摘要 → 中文要素」两次转译丢信息导致的误判
 *  （典型：词库原文 "A disease that is increasingly seen on children" 被压成「糖尿病是一种疾病」）。
 *  参考原文只用于判定**语义等价**，成档仍只看「核心要素」清单。
 */
export async function gradeDefinition(
  term: string,
  keypoints: KeypointRef[],
  answer: string,
  sourceDefs: Record<string, string> = {},
  opts: CompleteOpts = {},
): Promise<GradeResult> {
  const list = keypoints
    .map((k, i) => `${i + 1}. ${k.kind === 'example' ? '·' : '★'} ${k.text}`)
    .join('\n');
  const refs = Object.entries(sourceDefs ?? {})
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `- [${SOURCE_LABEL[k] ?? k}] ${v.trim()}`)
    .join('\n');
  const prompt = `你是剑桥 9699 A Level 社会学的阅卷官。学生在做「术语定义默写」，请**只判定每个要素的覆盖程度**，不要给档位。

术语：${term}
${refs ? `\n参考原文（英文，来自权威来源，供你判断语义等价用）：\n${refs}\n` : ''}
核心要素（★ = 定义主干，必须答到；· = 并列举例，举出其中若干项即可）：
${list}

学生答案：${answer}

请对每个要素给出覆盖度 coverage：
- ★ 主干要素：1.0 = 表达到位；0.5 = 只沾到一部分（说了半句、过于笼统）；0.0 = 没提到或说错
- · 举例要素：**只给 0.0 或 1.0 两档**（明确举出了这个例子 → 1.0；没提到或只是笼统说"有危害/有多种形式" → 0.0）

另外判断 listing_only（"是否只是罗列关键词"）：
- true 仅指**把关键词成串堆在一起、完全没有形成句子**（如"学业压力 屏幕时间 商业化"这样一串词）；
- 只要答案有主谓结构（如"儿童面临多种危害，例如学业压力、屏幕时间和商业化"），即使中间夹着举例，也算**正常陈述 → false**。

判定口径：
- 用中文或英文作答都算；**只要与「核心要素」或「参考原文」意思相同即算覆盖**，不要求用词一致、更不要求复述原文；
- **成档与否只看「核心要素」清单**——不要额外要求学生答出参考原文里的其它内容；
- 若学生举出的例子**已经体现了某个 ★ 主干要素**（例如主干说"科技变化造成危害"，学生举了"屏幕时间过长"），该主干要素可给 0.5 以上。

只输出 JSON（不要 markdown、不要解释）：
{"coverage":[1.0,0.0],"listing_only":false,"reason":"不超过40字的中文理由","confidence":0.0}`;

  const { text, model, tier, ms } = await callComplete(prompt, { maxTokens: 600, ...opts });
  const parsed = parseJsonLoose<{ coverage?: unknown; listing_only?: boolean; reason?: string }>(text) ?? {};
  const listingOnly = Boolean(parsed.listing_only);
  const coverage = (Array.isArray(parsed.coverage) ? parsed.coverage : []).map((x) => Number(x));
  return {
    verdict: verdictFromKeypoints(parsed.coverage, keypoints, listingOnly),
    coverage,
    listingOnly,
    reason: String(parsed.reason ?? ''),
    model,
    tier,
    ms,
  };
}
