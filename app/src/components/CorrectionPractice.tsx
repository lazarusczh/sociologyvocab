import { useMemo, useRef, useState } from 'react';
import { useStore, useStudySession } from '../lib/store';
import type { Quiz, QuizSubmission, VocabItem, QuizQuestion, CorrectionResult } from '../lib/types';
import { extractWrongItemIds, buildCorrectionQuestions, totalPoints, correctionBonus, applyGradingRules, isAnswerCorrect } from '../lib/quiz';
import { getMySubmission, saveCorrection } from '../lib/cloud';

// 订正组件：针对某次作业（homework）提交记录里的错题做「错题重做」
// 流程：错题词条 → 随机分配 选择/拼写 重新出题 → 逐题作答 → 完成订正：
//   1) 若订正全对且为作业：按规则快照结算加分（bonus）
//   2) 逐题 recordItem 计入打卡/掌握度/错题本（与正式练习权重一致）
//   3) saveCorrection 写回云端（correction 非 null 即视为已订正，入口锁死）
export default function CorrectionPractice({ quiz, submission, onDone, onCancel }: {
  quiz: Quiz;
  submission: QuizSubmission;
  onDone: (updated: QuizSubmission) => void;
  onCancel: () => void;
}) {
  const { vocab, authUser, recordItem } = useStore();

  // 错题词条 id（matching 块只取答错的配对词条）
  const wrongIds = useMemo(
    () => extractWrongItemIds(quiz.questions, submission.answers ?? {}),
    [quiz.questions, submission.answers],
  );

  // 词条解析：优先用当前词库（含 paper，干扰项更自然）；词库已删则用题目快照兜底
  const items = useMemo<VocabItem[]>(() => {
    const snapById = new Map(quiz.questions.map((q) => [q.itemId, q]));
    return wrongIds.map((id): VocabItem => {
      const cur = vocab.find((v) => v.id === id);
      if (cur) return cur;
      const snap = snapById.get(id);
      if (!snap) throw new Error(`词库中找不到错题词条：${id}`);
      return {
        id: snap.itemId,
        type: snap.itemType,
        term: snap.term,
        chinese: snap.chinese,
        definition: snap.definition,
        paper: '', // 快照无 paper，干扰项退化为跨 paper 同类型
        category: '',
        aliases: snap.aliases,
      };
    });
  }, [wrongIds, vocab, quiz.questions]);

  // 生成订正题（每个错题随机分配 选择/拼写）
  const questions = useMemo<QuizQuestion[]>(() => buildCorrectionQuestions(items, vocab), [items, vocab]);

  const [qi, setQi] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const savedRef = useRef(false);

  // 订正答题期间计入每日打卡学习时长（与题量计入口径一致）
  useStudySession(questions.length > 0);

  if (questions.length === 0) {
    return (
      <div className="card" style={{ maxWidth: 640, margin: '0 auto' }}>
        <div className="row" style={{ alignItems: 'center', marginBottom: '0.6rem' }}>
          <button className="ghost" onClick={onCancel}>← 返回</button>
          <span className="spacer" />
          <h3 style={{ margin: 0 }}>订正错题</h3>
        </div>
        <p className="muted">这份答卷没有需要订正的错题（或错题词条已不在词库中）。</p>
      </div>
    );
  }

  const q = questions[qi];
  const isLast = qi === questions.length - 1;

  const setAnswer = (val: string | number) => {
    setAnswers((prev) => ({ ...prev, [q.itemId]: val }));
  };

  const goNext = () => {
    if (isLast) submit(); else setQi((i) => i + 1);
  };

  const submit = async () => {
    if (busy || savedRef.current) return;
    savedRef.current = true;
    setBusy(true);
    setError('');
    const originalScore = submission.score ?? 0;
    const maxPoints = totalPoints(quiz.questions);
    // 未答的题目补空字符串（留空/跳过按答错计）
    const fullAnswers = { ...answers };
    for (const qq of questions) {
      if (fullAnswers[qq.itemId] === undefined) fullAnswers[qq.itemId] = '';
    }
    const details = questions.map((qq) => ({
      itemId: qq.itemId,
      type: qq.type,
      correct: isAnswerCorrect(qq, fullAnswers[qq.itemId]),
    }));
    const correctCount = details.filter((d) => d.correct).length;
    const allCorrect = correctCount === questions.length;
    const correction: CorrectionResult = {
      submitted_at: new Date().toISOString(),
      score: correctCount,
      total: questions.length,
      all_correct: allCorrect,
      details,
    };
    // 加分：仅作业 + 订正全对；percent 取规则快照（默认 10）
    const percent = quiz.grading_rules?.correction_bonus?.percent ?? 10;
    const bonus = allCorrect && quiz.kind === 'homework' ? correctionBonus(originalScore, maxPoints, percent) : 0;
    const grading = applyGradingRules(quiz, submission, bonus);
    try {
      await saveCorrection(submission.id, correction, grading);
      // 订正结果计入打卡/掌握度/错题本（只在云端保存成功后）
      for (const qq of questions) {
        recordItem(qq.itemId, isAnswerCorrect(qq, fullAnswers[qq.itemId]), qq.type);
      }
      // 回读最新记录（含 correction/grading）后回调
      let updated: QuizSubmission = { ...submission, correction, grading };
      if (authUser) {
        try {
          const fresh = await getMySubmission(quiz.id, authUser.id);
          if (fresh) updated = fresh;
        } catch { /* 回读失败用本地构造值兜底 */ }
      }
      onDone(updated);
    } catch (e) {
      savedRef.current = false;
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const picked = q.type === 'choice' && q.options ? (answers[q.itemId] === undefined ? null : Number(answers[q.itemId])) : null;

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: '0.6rem' }}>
        <button className="ghost" onClick={onCancel}>← 返回</button>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: '0.85rem' }}>订正错题 · 第 {qi + 1} / {questions.length} 题</span>
      </div>

      <div className="card">
        <div className="muted" style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span>{q.type === 'choice' ? '选择题' : '拼写'}</span>
          <span className={`badge ${q.itemType === 'term' ? 'success' : 'warn'}`} style={{ fontSize: '0.85rem', height: '1.6rem', lineHeight: '1.6rem', padding: '0 0.7rem' }}>
            {q.type === 'spelling'
              ? (q.itemType === 'term' ? '请填写：术语' : '请填写：学者')
              : (q.itemType === 'term' ? '术语' : '学者')}
          </span>
          <span>根据{q.promptLabel}作答</span>
        </div>
        <h2 style={{ margin: '0.5rem 0 1rem' }}>{q.prompt}</h2>

        {q.type === 'spelling' ? (
          <div>
            {q.chinese && <p className="muted" style={{ fontSize: '0.9rem' }}>中文：{q.chinese}</p>}
            {q.definition && q.chinese && <p className="muted" style={{ fontSize: '0.9rem' }}>释义提示：{q.definition}</p>}
            <div className="row" style={{ marginTop: '0.5rem', gap: '0.5rem' }}>
              <input
                autoFocus
                value={String(answers[q.itemId] ?? '')}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') goNext(); }}
                placeholder={q.itemType === 'term' ? '输入英文术语…' : '输入学者姓名…'}
                autoComplete="off"
                style={{ flex: 1 }}
              />
              <button className="primary" onClick={goNext} disabled={busy}>
                {isLast ? (busy ? '保存中…' : '完成订正') : '下一题 →'}
              </button>
            </div>
          </div>
        ) : (
          q.options && (
            <div>
              <div className="grid" style={{ gap: '0.5rem' }}>
                {q.options.map((opt, idx) => (
                  <button
                    key={idx}
                    className={`option-btn ${picked === idx ? 'selected' : ''}`}
                    onClick={() => setAnswer(idx)}
                  >
                    <span className="mark">{String.fromCharCode(65 + idx)}</span>
                    <span>{opt}</span>
                  </button>
                ))}
              </div>
              <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
                <button
                  className="primary"
                  onClick={goNext}
                  disabled={picked === null || busy}
                >
                  {isLast ? (busy ? '保存中…' : '完成订正') : '下一题 →'}
                </button>
              </div>
            </div>
          )
        )}
      </div>

      <div className="row" style={{ marginTop: '0.6rem', alignItems: 'center' }}>
        <button className="ghost" onClick={() => setQi((i) => Math.max(0, i - 1))} disabled={qi === 0}>上一题</button>
        <span className="muted" style={{ fontSize: '0.8rem', marginLeft: 'auto' }}>
          已作答 {questions.filter((qq) => answers[qq.itemId] !== undefined && answers[qq.itemId] !== '').length} / {questions.length} 题
        </span>
      </div>

      {error && <p className="gate-error" style={{ marginTop: '0.6rem' }}>{error}</p>}
    </div>
  );
}
