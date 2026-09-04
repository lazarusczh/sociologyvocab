// 随堂测验 / 作业：抽题、题目快照生成、判分、密码生成、乱序
import type { VocabItem, Quiz, QuizSubmission, QuizQuestion, QuizQuestionType, QuizKind, QuizPair } from './types';
import { shuffle, sample } from './shuffle';
import { maskAnswer, isCorrectAnswer } from './answers';

// 生成 4 位数字密码（查重交由云端唯一约束兜底，冲突时由调用方重试）
export function generateCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// 将词条按题型构造成一道「题目快照」
function buildQuestion(item: VocabItem, type: QuizQuestionType, pool: VocabItem[], idx: number): QuizQuestion {
  const maskedDef = maskAnswer(item, item.definition);
  const base = {
    id: `q${idx}`,
    type,
    itemId: item.id,
    itemType: item.type,
    term: item.term,
    aliases: item.aliases,
    chinese: item.chinese,
    definition: maskedDef,
  };
  // 干扰项只取同类型词条（术语题只出术语、学者题只出学者），
  // 否则学生按类型一眼排除选项；再优先同 paper，不够补其他 paper
  const samePaper = pool.filter((p) => p.id !== item.id && p.type === item.type && p.paper === item.paper);
  const restPaper = pool.filter((p) => p.id !== item.id && p.type === item.type && p.paper !== item.paper);

  if (type === 'spelling') {
    return {
      ...base,
      type: 'spelling',
      prompt: item.chinese || maskedDef,
      promptLabel: item.chinese ? '中文' : '释义',
    };
  }
  // choice（matching 由 buildMatchingBlock 单独处理）
  const dirs: ('term2def' | 'def2term' | 'cn2term')[] = ['term2def', 'def2term'];
  if (item.chinese) dirs.push('cn2term');
  const dir = dirs[Math.floor(Math.random() * dirs.length)];
  let prompt: string, answer: string, promptLabel: string, optionSource: 'term' | 'def';
  if (dir === 'term2def') {
    prompt = item.term;
    answer = maskedDef;
    promptLabel = '术语';
    optionSource = 'def';
  } else if (dir === 'def2term') {
    prompt = maskedDef;
    answer = item.term;
    promptLabel = '释义';
    optionSource = 'term';
  } else {
    prompt = item.chinese;
    answer = item.term;
    promptLabel = '中文';
    optionSource = 'term';
  }
  const pick = (src: VocabItem[]) => src
    .map((p) => (optionSource === 'term' ? p.term : maskAnswer(p, p.definition)))
    .filter((t) => t && t !== answer)
    .filter((t, i, arr) => arr.indexOf(t) === i);
  const wrong = [...pick(samePaper), ...pick(restPaper)].slice(0, 3);
  const options = shuffle([answer, ...wrong]);
  return {
    ...base,
    type: 'choice',
    prompt,
    promptLabel,
    options,
    answerIndex: options.indexOf(answer),
  };
}

// 生成匹配块：一组术语↔释义配对（pairs）
function buildMatchingBlock(items: VocabItem[], idx: number): QuizQuestion {
  const pairs = items.map((it) => ({
    itemId: it.id,
    term: it.term,
    definition: maskAnswer(it, it.definition),
  }));
  return {
    id: `q${idx}`,
    type: 'matching',
    itemId: pairs[0].itemId,
    itemType: 'term',
    term: '',
    chinese: '',
    definition: '',
    prompt: '将左侧术语与右侧释义一一配对',
    promptLabel: '匹配',
    pairs,
  };
}

// 按勾选题型均匀随机分配：把词条依次（洗牌后）分配到题型序列
function assignTypes(items: VocabItem[], types: QuizQuestionType[]): QuizQuestionType[] {
  if (types.length === 0) return [];
  const seq: QuizQuestionType[] = [];
  for (let i = 0; i < items.length; i++) {
    seq.push(types[i % types.length]);
  }
  return shuffle(seq); // 洗牌后仍保持题型数量均匀
}

// 每个匹配块的对数（与原 Matching.tsx 练习一致）
export const PAIRS_PER_BLOCK = 6;

// 生成整份题目的快照：items 为选中的词条，types 为勾选题型，pool 为干扰项来源（全库）
// matching 词条每 PAIRS_PER_BLOCK 个组成一个「配对块」；尾部不足 2 个的转为选择题
export function buildQuizQuestions(items: VocabItem[], types: QuizQuestionType[], pool: VocabItem[]): QuizQuestion[] {
  const typeSeq = assignTypes(items, types);
  const questions: QuizQuestion[] = [];
  let matchingBuffer: VocabItem[] = [];
  let idx = 0;

  const flushMatching = () => {
    while (matchingBuffer.length >= 2) {
      const chunk = matchingBuffer.splice(0, PAIRS_PER_BLOCK);
      questions.push(buildMatchingBlock(chunk, idx++));
    }
    if (matchingBuffer.length === 1) {
      questions.push(buildQuestion(matchingBuffer[0], 'choice', pool, idx++));
      matchingBuffer = [];
    }
  };

  for (let i = 0; i < items.length; i++) {
    const t = typeSeq[i];
    if (t === 'matching') {
      matchingBuffer.push(items[i]);
      if (matchingBuffer.length >= PAIRS_PER_BLOCK) {
        questions.push(buildMatchingBlock(matchingBuffer.splice(0, PAIRS_PER_BLOCK), idx++));
      }
    } else {
      questions.push(buildQuestion(items[i], t, pool, idx++));
    }
  }
  flushMatching();

  return questions;
}

// 计算一份题目的总评分点数（拼写/选择每题 1 点；匹配块每对 1 点）
export function totalPoints(questions: QuizQuestion[]): number {
  return questions.reduce((sum, q) => sum + (q.type === 'matching' && q.pairs ? q.pairs.length : 1), 0);
}

// 随机抽题：从池中抽 n 条（需含释义与术语）
export function sampleItems(pool: VocabItem[], n: number): VocabItem[] {
  const usable = pool.filter((i) => i.definition && i.term);
  return sample(usable, Math.min(n, usable.length));
}

// 判断单道题的作答是否正确（choice 传下标，spelling 传文本；matching 块不适用）
export function isAnswerCorrect(q: QuizQuestion, answer: string | number | undefined | null): boolean {
  if (q.type === 'choice') {
    const idx = Number(answer);
    return Number.isInteger(idx) && idx === q.answerIndex;
  }
  if (answer === undefined || answer === null || answer === '') return false;
  const asItem: VocabItem = {
    id: q.itemId,
    type: q.itemType,
    term: q.term,
    chinese: q.chinese,
    definition: q.definition,
    paper: '',
    category: '',
    aliases: q.aliases,
  };
  return isCorrectAnswer(asItem, String(answer));
}

// 匹配块：学生答对的对数（answers[术语itemId] === 自身 itemId 即配对正确）
export function matchingCorrectCount(q: QuizQuestion, answers: Record<string, string | number>): number {
  if (q.type !== 'matching' || !q.pairs) return 0;
  return q.pairs.reduce((n, p) => n + (answers[p.itemId] === p.itemId ? 1 : 0), 0);
}

// 学生作答的展示文本（choice 转成选项文本；spelling 原样）
export function answerText(q: QuizQuestion, answer: string | number | undefined | null): string {
  if (answer === undefined || answer === null || answer === '') return '';
  if (q.type === 'choice') {
    const idx = Number(answer);
    return Number.isInteger(idx) && q.options ? (q.options[idx] ?? '') : '';
  }
  return String(answer);
}

// 正确答案的展示文本
export function correctAnswerText(q: QuizQuestion): string {
  if (q.type === 'choice') {
    return q.options && q.answerIndex != null ? (q.options[q.answerIndex] ?? '') : q.term;
  }
  return q.term;
}

// 判分：answers 为 { itemId -> 作答 }；拼写作答是文本、选择是 options 下标、匹配块按正确配对数计分
export function gradeQuiz(questions: QuizQuestion[], answers: Record<string, string | number>): number {
  let score = 0;
  for (const q of questions) {
    if (q.type === 'matching' && q.pairs) {
      score += matchingCorrectCount(q, answers);
    } else if (isAnswerCorrect(q, answers[q.itemId])) {
      score++;
    }
  }
  return score;
}

// 重判辅助：把拼写题的 aliases 用「当前词库」最新值覆盖（题目快照不会随词库发布自动更新）。
// 返回新数组；词条不在词库、或 aliases 未变化、或非拼写题时返回原对象（可用引用比较判断是否有变化）。
// 覆盖后若词库未配置 aliases 则置 undefined，判分时自然回退到内置静态别名（answer-aliases.json）。
export function refreshQuestionAliases(
  questions: QuizQuestion[],
  itemById: Map<string, VocabItem>,
): QuizQuestion[] {
  return questions.map((q) => {
    if (q.type !== 'spelling') return q;
    const it = itemById.get(q.itemId);
    if (!it) return q;
    const cur = it.aliases ?? [];
    const prev = q.aliases ?? [];
    if (cur.length === prev.length && cur.every((a, i) => a === prev[i])) return q;
    return { ...q, aliases: cur.length ? cur : undefined };
  });
}

// 生成题目乱序种子（学生端进入时用于打乱题目顺序与选择题选项）
export function randomOrderSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

// 用种子乱序题目数组（确定性：同一种子同一次序）
export function shuffleQuestionsBySeed<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed || 1;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 格式化限时显示（分钟 → "X 分钟" 或 "X 小时 Y 分钟"）
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`;
}

// ===== 订正（错题重做 + 加分） =====

// 从一份已交卷的作答里提取「错题词条 id」（去重）：
// 拼写/选择答错 → 该词条；匹配块只取答错的那几对词条（不整块重做）
export function extractWrongItemIds(questions: QuizQuestion[], answers: Record<string, string | number>): string[] {
  const wrong = new Set<string>();
  for (const q of questions) {
    if (q.type === 'matching' && q.pairs) {
      for (const p of q.pairs) {
        if (answers[p.itemId] !== p.itemId) wrong.add(p.itemId);
      }
    } else if (!isAnswerCorrect(q, answers[q.itemId])) {
      wrong.add(q.itemId);
    }
  }
  return [...wrong];
}

// 为错题词条生成订正题目：每个词条随机分配 选择/拼写 题型，复用 buildQuestion（同 paper 干扰项）
export function buildCorrectionQuestions(items: VocabItem[], pool: VocabItem[]): QuizQuestion[] {
  return items.map((item, i) => buildQuestion(item, Math.random() < 0.5 ? 'choice' : 'spelling', pool, i));
}

// 订正加分：仅「订正全对且作业（homework）」时结算。
// 算法取更高者：final1 = min(S + M×percent%, M)；final2 = √(S×M)；取 max 后四舍五入取整，再减去原始分
export function correctionBonus(S: number, M: number, percent = 10): number {
  if (M <= 0 || S >= M) return 0; // 已满分无加分空间
  const final1 = Math.min(S + (M * percent) / 100, M);
  const final2 = Math.sqrt(S * M);
  const finalScore = Math.round(Math.max(final1, final2));
  return Math.max(finalScore - S, 0);
}

// 订正后的统一评分结算：罚分先扣、加分后加、封底 0 / 封顶真实满分
// 返回新的 grading 对象（沿用原 penalty/late 字段，更新 bonus/final_score）
export function applyGradingRules(
  quiz: Quiz,
  sub: Pick<QuizSubmission, 'score' | 'grading'>,
  bonus: number,
): NonNullable<QuizSubmission['grading']> {
  const M = totalPoints(quiz.questions);
  const penalty = sub.grading?.penalty ?? 0;
  const finalScore = Math.max(0, Math.min(sub.score - penalty + bonus, M));
  return {
    ...(sub.grading ?? {}),
    bonus,
    final_score: finalScore,
  };
}

// 题型中文名
export const TYPE_LABELS: Record<QuizQuestionType, string> = {
  spelling: '拼写',
  choice: '选择',
  matching: '匹配',
};

// kind 中文名
export const KIND_LABELS: Record<QuizKind, string> = {
  quiz: '随堂测验',
  homework: '作业',
};

// ===== 错题分析（教师：跨卷全局错题榜） =====

// 单次「词条作答」的判定记录：聚合最小单元（拼写/选择每词条一条；匹配块每对各一条）。
// 收集时只负责按题目快照判对错并携带展示信息，切片过滤/排除测试账号由调用方处理。
export interface WrongAttempt {
  itemId: string;
  term: string;              // 词条展示文本（题目快照）
  chinese: string;           // 中文（快照，可空）
  itemType: 'term' | 'scholar';
  qtype: QuizQuestionType;
  quizId: string;
  quizTitle: string;
  quizKind: QuizKind;
  submittedAt: string | null;
  userId: string;
  name: string | null;
  email: string | null;
  correct: boolean;
  prompt: string;            // 题干（下钻展示）
  studentAnswer: string;     // 学生作答展示文本（答对时为空）
  correctAnswer: string;     // 正确答案展示文本（答对时为空）
}

// 匹配块下钻：把学生选中的释义 id 还原成释义文本（未配对返回空串）
function matchingChosenLabel(pairs: QuizPair[], chosen: string | number | undefined | null): string {
  if (chosen === undefined || chosen === null || chosen === '') return '';
  const pair = pairs.find((p) => p.itemId === chosen);
  return pair ? pair.definition : String(chosen);
}

// 遍历已交卷记录，逐题（匹配块逐对）复用现有判分函数判定对错，产出词条级作答明细。
// 判分口径与现有成绩/订正完全一致：选择按下标、拼写走别名容错、匹配按 itemId 配对。
export function collectWrongAttempts(
  quizzes: Quiz[],
  submissions: QuizSubmission[],
): WrongAttempt[] {
  const quizById = new Map<string, Quiz>();
  for (const q of quizzes) quizById.set(q.id, q);
  const out: WrongAttempt[] = [];
  for (const s of submissions) {
    if (s.status !== 'submitted') continue;
    const quiz = quizById.get(s.quiz_id);
    if (!quiz) continue;
    const answers = s.answers ?? {};
    const base = {
      quizId: quiz.id,
      quizTitle: quiz.title,
      quizKind: quiz.kind,
      submittedAt: s.submitted_at,
      userId: s.user_id,
      name: s.name,
      email: s.email,
    };
    for (const q of quiz.questions) {
      if (q.type === 'matching' && q.pairs) {
        for (const p of q.pairs) {
          const chosen = answers[p.itemId];
          const correct = chosen === p.itemId;
          out.push({
            ...base,
            itemId: p.itemId,
            term: p.term,
            chinese: '',
            itemType: q.itemType,
            qtype: 'matching',
            correct,
            prompt: q.prompt,
            studentAnswer: correct ? '' : (matchingChosenLabel(q.pairs, chosen) || '（未配对）'),
            correctAnswer: correct ? '' : p.definition,
          });
        }
      } else {
        const a = answers[q.itemId];
        const correct = isAnswerCorrect(q, a);
        out.push({
          ...base,
          itemId: q.itemId,
          term: q.term,
          chinese: q.chinese ?? '',
          itemType: q.itemType,
          qtype: q.type,
          correct,
          prompt: q.prompt,
          studentAnswer: correct ? '' : (answerText(q, a) || '（未作答）'),
          correctAnswer: correct ? '' : correctAnswerText(q),
        });
      }
    }
  }
  return out;
}
