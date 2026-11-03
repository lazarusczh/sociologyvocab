/**
 * mbStale.ts 的自测（纯函数，无网络）。
 * 跑法：cd app && npx tsx scripts/mb-stale-selftest.mts
 * 若没有 tsx：node --experimental-strip-types scripts/mb-stale-selftest.mts（Node 22+）
 */
import { staleAgainstSnapshot, staleLabel, finalScoreOf, latestPerUser, type StaleSub } from '../src/lib/mbStale.ts';

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}\n     got ${a}\n     want ${e}`); }
}

const sub = (
  user_id: string,
  score: number,
  final?: number | null,
  status = 'submitted',
  submitted_at = '2026-11-01T00:00:00Z',
): StaleSub => ({
  user_id,
  status,
  score,
  submitted_at,
  grading: final === undefined ? null : { final_score: final },
});

console.log('— finalScoreOf：优先 final_score，否则 score');
check('有 final_score', finalScoreOf(sub('u1', 10, 14)), 14);
check('无 final_score 用原始分', finalScoreOf(sub('u1', 10, null)), 10);
check('grading 为 null 用原始分', finalScoreOf({ score: 7, grading: null }), 7);

console.log('— latestPerUser：同一学生取最近一次，非 submitted 不计');
{
  const a = { ...sub('u1', 5), submitted_at: '2026-11-01T00:00:00Z' };
  const b = { ...sub('u1', 9), submitted_at: '2026-11-02T00:00:00Z' };
  const c = sub('u2', 3, 3, 'in_progress');
  const m = latestPerUser([a, b, c]);
  check('只留最近一次', m.get('u1')?.score, 9);
  check('未交卷的学生不计', m.has('u2'), false);
}

console.log('— 从未登分：不报需更新');
check('snapshot=null', staleAgainstSnapshot([sub('u1', 10)], null),
  { stale: false, changedCount: 0, lastWrittenAt: null, lastSource: null });

console.log('— 分数没变：已同步');
check('一致',
  staleAgainstSnapshot([sub('u1', 10, 14)], { scores: { u1: '14' }, written_at: 'T1', source: 'auto' }),
  { stale: false, changedCount: 0, lastWrittenAt: 'T1', lastSource: 'auto' });

console.log('— 订正加分导致变化：需重新登分');
check('一人变了',
  staleAgainstSnapshot([sub('u1', 10, 14)], { scores: { u1: '10' }, written_at: 'T1', source: 'auto' }),
  { stale: true, changedCount: 1, lastWrittenAt: 'T1', lastSource: 'auto' });

console.log('— 加分卡叠加：同样识别');
check('card_bonus 已计入 final_score',
  staleAgainstSnapshot([sub('u1', 10, 16)], { scores: { u1: '14' }, written_at: 'T1', source: 'auto' }),
  { stale: true, changedCount: 1, lastWrittenAt: 'T1', lastSource: 'auto' });

console.log('— 快照里没有的学生：不算变了（教师只登了部分行）');
check('新学生不触发',
  staleAgainstSnapshot([sub('u1', 10, 14), sub('u2', 5, 6)], { scores: { u1: '14' }, written_at: 'T1', source: 'auto' }),
  { stale: false, changedCount: 0, lastWrittenAt: 'T1', lastSource: 'auto' });

console.log('— 学生记录被删：不触发');
check('快照有、答卷没了',
  staleAgainstSnapshot([], { scores: { u1: '10' }, written_at: 'T1', source: 'auto' }),
  { stale: false, changedCount: 0, lastWrittenAt: 'T1', lastSource: 'auto' });

console.log('— 手动标记后分数又变：仍要提示');
check('manual 后变化',
  staleAgainstSnapshot([sub('u1', 10, 18)], { scores: { u1: '14' }, written_at: 'T2', source: 'manual' }),
  { stale: true, changedCount: 1, lastWrittenAt: 'T2', lastSource: 'manual' });

console.log('— 多人分别变化：计数正确');
check('两人变了',
  staleAgainstSnapshot(
    [sub('u1', 10, 14), sub('u2', 5, 8), sub('u3', 3, 3)],
    { scores: { u1: '10', u2: '6', u3: '3' }, written_at: 'T1', source: 'auto' },
  ),
  { stale: true, changedCount: 2, lastWrittenAt: 'T1', lastSource: 'auto' });

console.log('— 数字与字符串混用不出错（jsonb 取回可能是数字）');
check('分数是数字也一致',
  staleAgainstSnapshot([sub('u1', 10, 14)], { scores: { u1: 14 as unknown as string }, written_at: 'T1', source: 'auto' }),
  { stale: false, changedCount: 0, lastWrittenAt: 'T1', lastSource: 'auto' });

console.log('— 徽章文案');
check('未记录', staleLabel({ stale: false, changedCount: 0, lastWrittenAt: null, lastSource: null }), '未记录登分');
check('已同步', staleLabel({ stale: false, changedCount: 0, lastWrittenAt: 'T1', lastSource: 'auto' }), '已同步');
check('需重登', staleLabel({ stale: true, changedCount: 3, lastWrittenAt: 'T1', lastSource: 'auto' }), '需重新登分 3 人');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
