/**
 * 重判前检查的纯逻辑自测（19 项）。
 *
 * 跑法（**必须打包，不能直接 node 跑**）：
 *   cd app
 *   npx esbuild scripts/regrade-hints-selftest.mts --bundle --platform=node --format=esm \
 *     --outfile="$env:TEMP\rg.mjs" && node "$env:TEMP\rg.mjs"
 *
 * 为什么不能像 `mb-stale-selftest.mts` 那样直接 `node --experimental-strip-types`：
 * 那个脚本测的 `mbStale.ts` 是自包含的，而本模块 import 了 `quiz.ts`，后者又 import
 * 了 `answers.ts` / `crossword.ts` / `shuffle.ts`——node 的 strip-types 不做路径补全，
 * 会报 `ERR_MODULE_NOT_FOUND: Cannot find module .../src/lib/quiz`。
 */
import {
  aliasClusters,
  aliasSnapshotChanged,
  driftLabel,
  hasMalformedAnswers,
  scoreDrift,
  type HintSub,
} from '../src/lib/regradeHints.ts';
import type { QuizQuestion } from '../src/lib/types.ts';

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n       actual   = ${a}\n       expected = ${e}`);
  }
}

// 一份只有两道拼写题的小卷：Boundary / Subculture
const questions: QuizQuestion[] = [
  {
    id: 'q0',
    type: 'spelling',
    itemId: 'it-boundary',
    itemType: 'term',
    term: 'Boundary',
    chinese: '边界',
    prompt: '边界',
    definition: 'the line that marks the limits',
    aliases: ['frontier'],
  } as unknown as QuizQuestion,
  {
    id: 'q1',
    type: 'spelling',
    itemId: 'it-subculture',
    itemType: 'term',
    term: 'Subculture',
    chinese: '亚文化',
    prompt: '亚文化',
    definition: 'a culture within a larger culture',
  } as unknown as QuizQuestion,
];

function sub(
  id: string,
  user_id: string,
  name: string,
  boundary: string,
  subculture: string,
  score: number,
): HintSub {
  return {
    id,
    user_id,
    name,
    status: 'submitted',
    score,
    answers: { 'it-boundary': boundary, 'it-subculture': subculture },
  };
}

console.log('scoreDrift');
{
  // 三份答卷：库里分数与重放一致 → 无漂移
  const subs = [
    sub('s1', 'u1111', 'Ann', 'boundary', 'subculture', 2),
    sub('s2', 'u2222', 'Bob', 'Boundary', 'subculture', 2),
  ];
  const d = scoreDrift(questions, subs);
  check('无漂移 changed=0', d.changed, 0);
  check('无漂移 total', d.total, 2);
  check('无漂移 label=null', driftLabel(d), null);

  // 库里只记了 1 分（历史口径），重放得 2 分 → 有漂移
  const d2 = scoreDrift(questions, [sub('s1', 'u1111', 'Ann', 'boundary', 'subculture', 1)]);
  check('有漂移 changed=1', d2.changed, 1);
  check('有漂移 samples', d2.samples, [{ name: 'Ann', from: 1, to: 2 }]);
  check('有漂移 label', driftLabel(d2), '1 份可比对的答卷里，有 1 份的原始分与当前口径不一致');

  // 未交卷不计入分母
  const d3 = scoreDrift(questions, [
    { id: 's9', user_id: 'u9999', status: 'in_progress', score: 0, answers: {} },
  ]);
  check('未交卷不进分母', d3.total, 0);

  // 无姓名时退化显示，不泄露邮箱
  const d4 = scoreDrift(questions, [sub('s5', 'uabcd1234', '', 'boundary', 'subculture', 0)]);
  check('无名退化显示', d4.samples[0].name, '学生 uabc');

  // ⚠ 迟交罚分不参与漂移判定：即使这条记录带着很大的 penalty / 很低的 final_score，
  // 只要 score 与重放一致，就**不算**漂移（这也是教师看到「16→15」不该联想到罚分的原因）。
  const lateSub = {
    ...sub('s6', 'ulate001', '迟到生', 'boundary', 'subculture', 2),
    grading: { penalty: 1, penalty_percent: 40, final_score: 1 },
  } as unknown as HintSub;
  const d5 = scoreDrift(questions, [lateSub]);
  check('罚分不参与漂移 changed=0', d5.changed, 0);
  check('罚分不参与漂移 label=null', driftLabel(d5), null);
}

console.log('hasMalformedAnswers');
{
  // spelling 收到词条 id —— 历史交卷 bug 的形态，必须识别出来
  check('拼写题存 itemId', hasMalformedAnswers(questions, { 'it-boundary': 'term_141vk24u7ja26' }), true);
  check('拼写题存 scholar id', hasMalformedAnswers(questions, { 'it-boundary': 'sch_abc123' }), true);
  check('拼写题存数字', hasMalformedAnswers(questions, { 'it-boundary': 2 }), true);
  // 正常作答
  check('拼写题正常文本', hasMalformedAnswers(questions, { 'it-boundary': 'Boundry' }), false);
  check('空答卷', hasMalformedAnswers(questions, {}), false);
  check('空白作答', hasMalformedAnswers(questions, { 'it-boundary': '   ' }), false);

  // 选择题：下标（数字 / 纯数字串）正常；文本异常
  const choiceQ = [
    { ...questions[0], type: 'choice', options: ['a', 'b'], answerIndex: 0 } as unknown as QuizQuestion,
  ];
  check('选择题存数字下标', hasMalformedAnswers(choiceQ, { 'it-boundary': 0 }), false);
  check('选择题存数字串下标', hasMalformedAnswers(choiceQ, { 'it-boundary': '1' }), false);
  check('选择题存选项文本', hasMalformedAnswers(choiceQ, { 'it-boundary': 'Semi-peripheral country' }), true);
  check('选择题存 itemId', hasMalformedAnswers(choiceQ, { 'it-boundary': 'term_zqrgx4whm8ow' }), true);
  // ⚠ 前面题异常、后面题正常时不能被后面的正常值「洗白」
  check('前面的题异常就不放过', hasMalformedAnswers(
    [choiceQ[0], ...questions],
    { 'it-boundary': 'some text', 'it-subculture': 'subculture' },
  ), true);
}

console.log('形态异常答卷不参与漂移');
{
  // Alyssa 型答卷：拼写题全存 itemId ⇒ 重放必然低分，但这不是口径问题，不提示
  const malformed = {
    id: 'm1', user_id: 'umal0001', name: '慕韶菲', status: 'submitted', score: 20,
    answers: { 'it-boundary': 'term_141vk24u7ja26', 'it-subculture': 'term_bz9k5wb05vdw' },
  } as unknown as HintSub;
  const dm = scoreDrift(questions, [malformed]);
  check('形态异常不计变更', dm.changed, 0);
  check('形态异常不计分母', dm.total, 0);
  check('形态异常 label=null', driftLabel(dm), null);

  // 与正常答卷混在一起：正常的那份仍要参与
  const dm2 = scoreDrift(questions, [
    malformed,
    sub('s1', 'u1111', 'Ann', 'boundary', 'subculture', 1),
  ]);
  check('混合时只算正常的', dm2.total, 1);
  check('混合时正常的有漂移', dm2.changed, 1);
  check('混合时只列正常人', dm2.samples.map((x) => x.name), ['Ann']);
}

console.log('aliasSnapshotChanged');
{
  // 引用相同 ⇒ 没变
  check('同一数组引用=未变', aliasSnapshotChanged(questions, questions), false);
  // 长度不同 ⇒ 变了
  check('长度不同=变了', aliasSnapshotChanged(questions, [questions[0]]), true);
  // 元素被替换 ⇒ 变了
  const refreshed = [questions[0], { ...questions[1], aliases: ['sub-culture'] } as unknown as QuizQuestion];
  check('元素被替换=变了', aliasSnapshotChanged(questions, refreshed), true);
  // 逐元素引用相同的新数组 ⇒ 未变（refreshQuestionAliases 无变化时的实际形态）
  check('逐项同一引用=未变', aliasSnapshotChanged(questions, [questions[0], questions[1]]), false);
}

console.log('aliasClusters');
{
  // 3 人写 "boundary" 但都被判错（模拟 alias 缺了这个写法）—— 注意 normalizeKey 会把它判对，
  // 所以这里真正能聚成簇的必须是判错的。构造一个 "Boundry"（拼错）供 3 人重复。
  const subs = [
    sub('s1', 'u1111', 'Ann', 'Boundry', 'subculture', 1),
    sub('s2', 'u2222', 'Bob', 'Boundry', 'subculture', 1),
    sub('s3', 'u3333', 'Cid', 'Boundry', 'subculture', 1),
  ];
  const c = aliasClusters(questions, subs, 2);
  check('聚成一簇', c.length, 1);
  check('簇的用户数', c[0].users, 3);
  check('簇的原始文本', c[0].answer, 'Boundry');
  check('簇的词条', c[0].term, 'Boundary');
  check('簇的名字', c[0].names, ['Ann', 'Bob', 'Cid']);

  // 同一卷里不同卷/不同题的相同文本不应混簇（此处只有一题能对）
  // 人数不足阈值 → 不提示
  const c1 = aliasClusters(questions, [sub('s1', 'u1111', 'Ann', 'Boundry', 'subculture', 1)], 2);
  check('单人不成簇', c1.length, 0);
  check('minUsers=1 时可成簇', aliasClusters(questions, [sub('s1', 'u1111', 'Ann', 'Boundry', 'subculture', 1)], 1).length, 1);

  // 判对的重复作答不算缺口（大小写差异本来就判对）
  const ok = [
    sub('s1', 'u1111', 'Ann', 'boundary', 'subculture', 2),
    sub('s2', 'u2222', 'Bob', 'boundary', 'subculture', 2),
  ];
  check('判对的不算缺口', aliasClusters(questions, ok, 2).length, 0);

  // 未作答不聚簇
  const blanks = [
    sub('s1', 'u1111', 'Ann', '', 'subculture', 1),
    sub('s2', 'u2222', 'Bob', '', 'subculture', 1),
  ];
  check('未作答不聚簇', aliasClusters(questions, blanks, 2).length, 0);

  // 形态异常的答卷不参与聚簇：两个人拼写题都存了同一个 itemId，
  // 若参与就会被聚成「2 人都写 term_xxx」的假缺口。
  const malformedDup = [
    { id: 'm1', user_id: 'u1', name: 'A', status: 'submitted', score: 0, answers: { 'it-boundary': 'term_abc123', 'it-subculture': 'term_abc123' } },
    { id: 'm2', user_id: 'u2', name: 'B', status: 'submitted', score: 0, answers: { 'it-boundary': 'term_abc123', 'it-subculture': 'term_abc123' } },
  ] as HintSub[];
  check('形态异常不聚簇', aliasClusters(questions, malformedDup, 2).length, 0);

  // 排序：人多优先
  const mixed = [
    sub('s1', 'u1', 'A', 'Boundry', 'subcultre', 0),
    sub('s2', 'u2', 'B', 'Boundry', 'subcultre', 0),
    sub('s3', 'u3', 'C', 'Boundry', 'zzz', 1),
  ];
  const mc = aliasClusters(questions, mixed, 2);
  check('人多优先排序', mc.map((x) => [x.term, x.users]), [['Boundary', 3], ['Subculture', 2]]);

  // 非拼写题（choice/matching/crossword）不参与
  const choiceQ = [{ ...questions[0], type: 'choice', options: ['a', 'b'], answerIndex: 0 } as unknown as QuizQuestion];
  const cs = [
    { id: 'x1', user_id: 'u1', name: 'A', status: 'submitted', score: 0, answers: { 'it-boundary': 'b' } },
    { id: 'x2', user_id: 'u2', name: 'B', status: 'submitted', score: 0, answers: { 'it-boundary': 'b' } },
  ] as HintSub[];
  check('选择题不聚簇', aliasClusters(choiceQ, cs, 2).length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
