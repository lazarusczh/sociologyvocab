// 随堂测验 / 作业：抽题、题目快照生成、判分、密码生成、乱序
import type { VocabItem, QuizQuestion, QuizQuestionType, QuizKind } from './types';
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
  // 干扰项优先取同 paper 词条，避免一眼看出不相关；同 paper 不够再补其他 paper
  const samePaper = pool.filter((p) => p.id !== item.id && p.paper === item.paper);
  const restPaper = pool.filter((p) => p.id !== item.id && p.paper !== item.paper);

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
