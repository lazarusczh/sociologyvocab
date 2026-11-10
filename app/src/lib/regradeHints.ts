/**
 * 「重判前检查」的两个提示 —— **纯计算，不依赖网络**。
 *
 * 存在理由同 `mbStale.ts`：可独立自测、可被教师端复用，不引入 supabase 副作用。
 *
 * 两块内容（教师点「重判」按钮之前看一眼）：
 *
 *   1. 口径已变（`scoreDrift`）：用**当前题目快照**重放判分，若结果与库里存的
 *      `score` 不一致，说明这份卷的判分口径已经跟当前词库/容错规则脱节了，
 *      重判会改分。这是**精确可自证**的：不猜任何答案，只比较「重放结果 vs 已存结果」。
 *
 *   2. 疑似别名缺口（`aliasClusters`）：同一道拼写题上，**多个学生写下完全相同的
 *      作答文本**却都被判错。同一个错法重复出现，往往不是学生各自拼错，而是
 *      容错规则缺了这个写法（首字母大小写、连字符、复数、英式/美式拼法等）。
 *      ⚠ 系统**只摆候选，不下判断** —— 两个学生同样拼错一个词也完全可能，
 *      是否真是缺口由教师判断。所以文案写「疑似」而不是「误判」。
 *
 * ⚠ 聚簇必须按**原始作答文本**精确分组，不能先过 `normalizeKey`：
 *   大小写/连字符差异本身是被判对的（见 `answers.ts` 的 normalizeKey），
 *   用它合并只会把判对的答对样本也卷进来，造出假信号。上一轮已用真实数据踩过这个坑。
 */

import type { QuizQuestion } from './types';
import { answerText, gradeQuiz, isAnswerCorrect } from './quiz';

/** 判定所需的最少字段（便于单测构造；与 QuizSubmission 兼容） */
export interface HintSub {
  id: string;
  user_id: string;
  status: string;
  score: number;
  name?: string | null;
  answers?: Record<string, string | number> | null;
}

/** 判分口径漂移：按当前快照重放得到的分数与库里存的不一致 */
export interface ScoreDrift {
  /** 可比对份数（分母）—— 已交卷里剔除了「答案落库形态异常」的答卷 */
  total: number;
  /** 重放后分数会变的份数 */
  changed: number;
  /** 变化明细（按变化幅度降序，最多 5 条，供教师核对） */
  samples: { name: string; from: number; to: number }[];
}

/** 疑似别名缺口：同题同错答文本的聚簇 */
export interface AliasCluster {
  itemId: string;
  term: string;
  /** 题干（展示用） */
  prompt: string;
  /** 学生写下的原始文本（彼此完全相同） */
  answer: string;
  /** 有多少人这样写 */
  users: number;
  /** 学生姓名（最多 5 个，其余省略） */
  names: string[];
}

const NO_ANSWER = '（未作答）';

// 未作答不是「写法差异」，不参与聚簇（否则每个空题都会聚成一簇）
function isBlankAnswer(s: string): boolean {
  return !s || s === NO_ANSWER;
}

/** 词条 id 的形态：`term_xxx` / `sch_xxx`。出现在「拼写题答案」里说明存错了字段。 */
const ITEM_ID_RE = /^(?:term|sch)_[a-z0-9]+$/i;

/**
 * 这份答卷的 `answers` 是否**落库形态异常**（不是「答错」，是「存的东西根本不是作答」）。
 *
 * 已知真实案例（`A2 Globalisation #1 (Week 11)`，2026-11 之前某个版本交卷路径的 bug）：
 *  - 拼写题存成词条 id（`"term_141vk24u7ja26"`）或数字；
 *  - 选择题存成选项**文本**（`"Semi-peripheral country"`）而不是下标；
 *  - 匹配题存成数字。
 * 这类答卷用当前判分器重放必然「全错」，但它与别名/容错规则毫无关系 ——
 * 拿它去比 `score` 只会造出「原始分与当前口径不一致」的假信号，正是教师说
 * 「完全不应该出现这种提示」的情形。所以这类答卷**不参与漂移比对**，
 * 也不计入分母（分母是「可比对份数」而不是「已交份数」）。
 *
 * 判别只看**值的形态**，不看 key 的多少：块型题（matching/crossword）展开后
 * 答案 key 数本来就与题目块数不等，用 key 数判别会把正常卷误伤（已用真实数据踩过）。
 */
export function hasMalformedAnswers(
  questions: QuizQuestion[],
  answers: Record<string, string | number> | null | undefined,
): boolean {
  const a = answers ?? {};
  for (const q of questions) {
    const raw = a[q.itemId];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;

    if (q.type === 'spelling') {
      if (typeof raw === 'number') return true;
      if (typeof raw === 'string' && ITEM_ID_RE.test(raw.trim())) return true;
      continue;
    }
    if (q.type === 'choice') {
      // 选择题的答案是选项下标；数字或纯数字字符串都算正常形态
      if (typeof raw === 'number') continue;
      if (typeof raw !== 'string') return true;
      if (!/^\d+$/.test(raw.trim())) return true;
      continue;
    }
    if (q.type === 'matching') {
      // 匹配题存的是配到的 itemId 文本；数字说明存成了下标
      if (typeof raw === 'number') return true;
      continue;
    }
    // crossword 等题型按格子/线索存，形态另有一套，不在本判据覆盖范围内
  }
  return false;
}

/**
 * 题目快照是否因为「当前词库的别名」而发生了变化。
 *
 * `refreshQuestionAliases` 无变化时会原对象返回，所以可以按引用比较。
 *
 * 用途：**只有当别名真的变了，才值得提示「重判会改分」**。判分口径也可能因为
 * 代码层面的归一化调整（例如 2026-09 给 `normalizeKey` 加了 `&`→`and`）而与旧分数
 * 脱节，但那种情况教师无法通过改别名解决，提示它只会变成永久噪音。
 */
export function aliasSnapshotChanged(
  stored: QuizQuestion[],
  refreshed: QuizQuestion[],
): boolean {
  if (stored.length !== refreshed.length) return true;
  return refreshed.some((q, i) => q !== stored[i]);
}

/** 学生展示名：优先姓名，退化为「学生」+ uid 前 4 位（不泄露邮箱） */
function displayName(s: HintSub): string {
  const n = (s.name ?? '').trim();
  return n || `学生 ${s.user_id.slice(0, 4)}`;
}

/**
 * 口径已变：用传入的 `questions`（调用方应已用当前词库刷新过 aliases）重放判分，
 * 与每份已交卷记录里存的 `score` 比较。
 *
 * 两类答卷被**排除在比对之外**（既不计变更、也不计入分母），因为它们产生的
 * 「不一致」都不是重判能修好、也不是教师需要看的：
 *  - 答案落库形态异常（见 `hasMalformedAnswers`）—— 重放必然全错，纯噪音；
 *  - 题目快照本身没变（`aliasSnapshotChanged` 为 false）—— 说明分差来自
 *    代码层归一化历史变更，改别名也改不动它。
 */
export function scoreDrift(questions: QuizQuestion[], subs: HintSub[]): ScoreDrift {
  const submitted = subs.filter((s) => s.status === 'submitted');
  const diffs: { name: string; from: number; to: number }[] = [];
  let comparable = 0;
  for (const s of submitted) {
    const answers = (s.answers ?? {}) as Record<string, string | number>;
    if (hasMalformedAnswers(questions, answers)) continue;
    comparable += 1;
    const to = gradeQuiz(questions, answers);
    const from = s.score ?? 0;
    if (to !== from) diffs.push({ name: displayName(s), from, to });
  }
  diffs.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  return { total: comparable, changed: diffs.length, samples: diffs.slice(0, 5) };
}

/**
 * 漂移提示文案（无漂移返回 null）。
 *
 * ⚠ 措辞必须写「原始分」：本函数比的是 `score`，**不含迟交罚分**。
 *   迟交罚分在交卷那一刻就按**满分**算定（`penalty = round(M * pct / 100)`，
 *   见 db-migration-grading-rules.sql:83），与当时的分数无关、此后也不随重判变化。
 *   写「会变分」会让教师以为罚分被重算。
 */
export function driftLabel(d: ScoreDrift): string | null {
  if (d.changed === 0) return null;
  // 分母是「可比对份数」，可能小于已交份数（形态异常的答卷被排除），所以不能写「已交答卷」。
  return `${d.total} 份可比对的答卷里，有 ${d.changed} 份的原始分与当前口径不一致`;
}

/**
 * 疑似别名缺口：同一道**拼写题**上，≥ `minUsers` 个学生写下**完全相同**的错答文本。
 *
 * 只统计拼写题：本项目的容错规则（`refreshQuestionAliases`）只作用于 spelling，
 * 选择题按选项下标、匹配按 itemId、填字按格子字母，都不存在「写法的别名」问题。
 */
export function aliasClusters(
  questions: QuizQuestion[],
  subs: HintSub[],
  minUsers = 2,
): AliasCluster[] {
  const byItem = new Map<string, QuizQuestion>();
  for (const q of questions) {
    if (q.type === 'spelling') byItem.set(q.itemId, q);
  }

  type Bucket = { q: QuizQuestion; answer: string; users: Map<string, string> };
  const buckets = new Map<string, Bucket>();

  for (const s of subs) {
    if (s.status !== 'submitted') continue;
    const answers = (s.answers ?? {}) as Record<string, string | number>;
    // 形态异常的答卷里，拼写题存的是词条 id 之类的非作答内容 —— 多个学生存进同一个
    // id 会被聚成一个「大家都这么写」的假簇，所以整份排除（与 scoreDrift 同口径）。
    if (hasMalformedAnswers(questions, answers)) continue;
    for (const [itemId, q] of byItem) {
      const raw = answers[itemId];
      // 与真实判分同口径：isAnswerCorrect 内部就是 normalizeKey 比对
      if (isAnswerCorrect(q, typeof raw === 'string' ? raw : String(raw ?? ''))) continue;
      const text = answerText(q, raw);
      if (isBlankAnswer(text)) continue;
      const key = `${itemId}\u0000${text}`;
      let b = buckets.get(key);
      if (!b) {
        b = { q, answer: text, users: new Map() };
        buckets.set(key, b);
      }
      b.users.set(s.user_id, displayName(s));
    }
  }

  const out: AliasCluster[] = [];
  for (const b of buckets.values()) {
    if (b.users.size < minUsers) continue;
    out.push({
      itemId: b.q.itemId,
      term: b.q.term,
      prompt: b.q.prompt,
      answer: b.answer,
      users: b.users.size,
      names: [...b.users.values()].slice(0, 5),
    });
  }
  // 人多优先；同人数按词条名稳定排序，避免每次渲染顺序跳动
  out.sort((a, b) => b.users - a.users || a.term.localeCompare(b.term));
  return out;
}
