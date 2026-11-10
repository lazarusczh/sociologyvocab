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
  /** 已交卷份数（分母） */
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

/** 学生展示名：优先姓名，退化为「学生」+ uid 前 4 位（不泄露邮箱） */
function displayName(s: HintSub): string {
  const n = (s.name ?? '').trim();
  return n || `学生 ${s.user_id.slice(0, 4)}`;
}

/**
 * 口径已变：用传入的 `questions`（调用方应已用当前词库刷新过 aliases）重放判分，
 * 与每份已交卷记录里存的 `score` 比较。
 */
export function scoreDrift(questions: QuizQuestion[], subs: HintSub[]): ScoreDrift {
  const submitted = subs.filter((s) => s.status === 'submitted');
  const diffs: { name: string; from: number; to: number }[] = [];
  for (const s of submitted) {
    const to = gradeQuiz(questions, (s.answers ?? {}) as Record<string, string | number>);
    const from = s.score ?? 0;
    if (to !== from) diffs.push({ name: displayName(s), from, to });
  }
  diffs.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  return { total: submitted.length, changed: diffs.length, samples: diffs.slice(0, 5) };
}

/**
 * 漂移提示文案（无漂移返回 null）。
 *
 * ⚠ 措辞必须写「原始分」：本函数比的是 `score`，**不含迟交罚分**。
 *   迟交罚分在交卷那一刻就按下分算定写进 `grading.penalty`，此后不随重判变化
 *   （见 db-migration-grading-rules.sql）。写「会变分」会让教师以为罚分被重算。
 */
export function driftLabel(d: ScoreDrift): string | null {
  if (d.changed === 0) return null;
  return `${d.total} 份已交答卷里，有 ${d.changed} 份的原始分与当前口径不一致`;
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
