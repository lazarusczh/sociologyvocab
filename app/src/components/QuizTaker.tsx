import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import type { Quiz, QuizQuestion, QuizSubmission } from '../lib/types';
import { getQuizByCode, getMySubmission, upsertSubmission, submitQuizSubmission, listMySubmissions } from '../lib/cloud';
import { gradeQuiz, shuffleQuestionsBySeed, randomOrderSeed, formatDuration, TYPE_LABELS, KIND_LABELS, isAnswerCorrect, answerText, correctAnswerText, matchingCorrectCount } from '../lib/quiz';
import { shuffle } from '../lib/shuffle';

type Phase = 'enter' | 'confirm' | 'taking' | 'done';

export default function QuizTaker() {
  const { authUser, setInQuiz } = useStore();
  const [phase, setPhase] = useState<Phase>('enter');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]); // 已按 seed 乱序
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [qi, setQi] = useState(0);
  const [score, setScore] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const [seed, setSeed] = useState(0);
  const [deadline, setDeadline] = useState<number | null>(null); // 截止时间戳（毫秒）
  const [now, setNow] = useState(Date.now());
  const [leaveCount, setLeaveCount] = useState(0);
  const [resumed, setResumed] = useState(false);

  // 历史结果
  const [historyView, setHistoryView] = useState(false);
  const [historyList, setHistoryList] = useState<{ sub: QuizSubmission; quiz: Quiz | null }[]>([]);
  const [historyDetail, setHistoryDetail] = useState<{ sub: QuizSubmission; quiz: Quiz } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const leaveCountRef = useRef(0);
  const leaveSecondsRef = useRef(0);
  const leftAtRef = useRef<number | null>(null);
  const submittedRef = useRef(false);
  const startTimeRef = useRef(0); // 首次开始答题时间（毫秒），保存/交卷时保持不再被覆盖

  // 退出考试时清理锁导航
  useEffect(() => {
    return () => setInQuiz(false);
  }, [setInQuiz]);

  // 打开历史结果列表
  const openHistory = async () => {
    if (!authUser) { setError('请先登录后查看历史结果'); return; }
    setHistoryLoading(true);
    setError('');
    try {
      setHistoryList(await listMySubmissions(authUser.id));
      setHistoryDetail(null);
      setHistoryView(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setHistoryLoading(false);
  };

  // 判断某份记录的结果是否已公布（due_at 为空 = 立即可见；否则需过 due_at）
  const isResultPublished = (quiz: Quiz | null): boolean => {
    if (!quiz?.due_at) return true;
    return new Date(quiz.due_at).getTime() <= Date.now();
  };

  // 查密码
  const lookup = async () => {
    const c = code.trim();
    if (!c) { setError('请输入 4 位密码'); return; }
    setBusy(true);
    setError('');
    try {
      const q = await getQuizByCode(c);
      if (!q) { setError('密码无效，请检查后重试'); setBusy(false); return; }
      // 统一开考时间校验
      if (q.open_at && new Date(q.open_at).getTime() > Date.now()) {
        setError(`尚未到开考时间：${new Date(q.open_at).toLocaleString()}`);
        setBusy(false);
        return;
      }
      // 作业截止时间校验
      if (q.due_at && new Date(q.due_at).getTime() < Date.now()) {
        setError('该作业已过截止时间');
        setBusy(false);
        return;
      }
      setQuiz(q);
      setPhase('confirm');
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  // 开始答题：拉取自己已有记录（判断是否已交卷/恢复草稿），确定乱序种子与截止时间
  const begin = async () => {
    if (!quiz || !authUser) return;
    setBusy(true);
    setError('');
    try {
      const existing = await getMySubmission(quiz.id, authUser.id);
      if (existing?.status === 'submitted') {
        setError('你已经交过卷了，不能重复作答');
        setBusy(false);
        return;
      }
      const mySeed = existing ? existing.order_seed : randomOrderSeed();
      setSeed(mySeed);
      setQuestions(shuffleQuestionsBySeed(quiz.questions, mySeed));
      if (existing) {
        setAnswers(existing.answers ?? {});
        setLeaveCount(existing.leave_count ?? 0);
        leaveCountRef.current = existing.leave_count ?? 0;
        leaveSecondsRef.current = existing.leave_seconds ?? 0;
        setResumed(true);
      }
      // 锁定首次开始时间；剩余答题秒数：首次 = 时长，恢复 = 冻结值（独立计时字段）
      const startTime = existing ? new Date(existing.started_at).getTime() : Date.now();
      startTimeRef.current = startTime;
      const remainingSec = existing?.remaining_seconds != null
        ? existing.remaining_seconds
        : quiz.duration_minutes * 60;
      setDeadline(Date.now() + remainingSec * 1000);
      setInQuiz(true);
      setPhase('taking');
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  // 倒计时
  useEffect(() => {
    if (phase !== 'taking' || !deadline) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase, deadline]);

  const remaining = deadline ? Math.max(0, Math.floor((deadline - now) / 1000)) : 0;

  // 作业提交截止是否已过（服务器交卷时仍会硬拦截，这里仅前端软提示/禁用）
  const dueAtMs = quiz?.due_at ? new Date(quiz.due_at).getTime() : null;
  const pastDue = quiz?.kind === 'homework' && dueAtMs != null && now >= dueAtMs;

  // 超时自动交卷
  useEffect(() => {
    if (phase === 'taking' && deadline && now >= deadline && !submitted) {
      doSubmit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, phase, deadline, submitted]);

  // 切屏/失焦记录
  useEffect(() => {
    if (phase !== 'taking') return;
    const onHide = () => {
      if (document.hidden || !document.hasFocus()) {
        if (leftAtRef.current === null) {
          leftAtRef.current = Date.now();
          leaveCountRef.current += 1;
          setLeaveCount(leaveCountRef.current);
        }
      } else if (leftAtRef.current !== null) {
        const dur = Math.floor((Date.now() - leftAtRef.current) / 1000);
        leftAtRef.current = null;
        if (dur > 0) leaveSecondsRef.current += dur;
      }
    };
    const onBlur = () => {
      if (leftAtRef.current === null) {
        leftAtRef.current = Date.now();
        leaveCountRef.current += 1;
        setLeaveCount(leaveCountRef.current);
      }
    };
    const onFocus = () => {
      if (leftAtRef.current !== null) {
        const dur = Math.floor((Date.now() - leftAtRef.current) / 1000);
        leftAtRef.current = null;
        if (dur > 0) leaveSecondsRef.current += dur;
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [phase]);

  // 交卷
  const doSubmit = useCallback(async () => {
    if (!quiz || !authUser || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    setBusy(true);
    setError('');
    const finalScore = gradeQuiz(questions, answers);
    setScore(finalScore);
    try {
      await submitQuizSubmission({
        quiz_id: quiz.id,
        user_id: authUser.id,
        email: authUser.email,
        name: authUser.name,
        answers,
        score: finalScore,
        started_at: new Date(startTimeRef.current).toISOString(),
        leave_count: leaveCountRef.current,
        leave_seconds: leaveSecondsRef.current,
        order_seed: seed,
      });
      setInQuiz(false);
      setPhase('done');
    } catch (e) {
      // 交卷失败：解除锁定，允许重试并显示错误
      submittedRef.current = false;
      setSubmitted(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [quiz, authUser, questions, answers, seed, setInQuiz]);

  // 作业模式：保存并退出（不判分，记录草稿）
  const saveAndExit = async () => {
    if (!quiz || !authUser) return;
    setBusy(true);
    setError('');
    try {
      // 冻结当前剩余答题秒数
      const remainingSec = Math.max(0, Math.floor(((deadline ?? Date.now()) - Date.now()) / 1000));
      await upsertSubmission({
        quiz_id: quiz.id,
        user_id: authUser.id,
        email: authUser.email,
        name: authUser.name,
        answers,
        score: 0,
        status: 'in_progress',
        started_at: new Date(startTimeRef.current).toISOString(),
        submitted_at: null,
        leave_count: leaveCountRef.current,
        leave_seconds: leaveSecondsRef.current,
        order_seed: seed,
        remaining_seconds: remainingSec,
      });
      setInQuiz(false);
      setPhase('enter');
      setQuiz(null);
      setCode('');
      setAnswers({});
      setQi(0);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;

  const setAnswer = (val: string | number) => {
    if (!quiz) return;
    const q = questions[qi];
    setAnswers((prev) => ({ ...prev, [q.itemId]: val }));
  };

  // ---- 渲染 ----
  if (phase === 'enter') {
    // 历史结果视图
    if (historyView) {
      return (
        <div>
          <h1>历史结果</h1>
          <div className="card" style={{ maxWidth: 640, margin: '0 auto' }}>
            <div className="row" style={{ alignItems: 'center', marginBottom: '0.6rem' }}>
              <button className="ghost" onClick={() => { setHistoryView(false); setHistoryDetail(null); setCode(''); }}>← 返回</button>
              <span className="spacer" />
              <span className="muted" style={{ fontSize: '0.85rem' }}>已提交的测验与作业</span>
            </div>
            {error && <p className="gate-error" style={{ marginBottom: '0.6rem' }}>{error}</p>}
            {historyLoading ? (
              <p className="muted">加载中…</p>
            ) : historyDetail ? (
              <HistoryDetail detail={historyDetail} onBack={() => setHistoryDetail(null)} />
            ) : historyList.length === 0 ? (
              <div className="empty-state"><p className="muted">还没有已提交的测验或作业。</p></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {historyList.map(({ sub, quiz: q }) => {
                  const published = isResultPublished(q);
                  return (
                    <div key={sub.id} style={{ border: '1px solid var(--border)', borderRadius: '0.4rem', padding: '0.6rem 0.8rem' }}>
                      <div className="row" style={{ alignItems: 'center' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600 }}>{q?.title ?? '（已删除的测验）'}</div>
                          <div className="muted" style={{ fontSize: '0.8rem' }}>
                            {q ? `${KIND_LABELS[q.kind]} · ` : ''}交卷于 {sub.submitted_at ? new Date(sub.submitted_at).toLocaleString() : '—'}
                          </div>
                        </div>
                        {published ? (
                          <span style={{ fontWeight: 700 }}>{sub.score} / {q?.question_count ?? '?'}</span>
                        ) : (
                          <span className="muted" style={{ fontSize: '0.8rem' }}>结果尚未公布</span>
                        )}
                      </div>
                      {published && q && (
                        <button className="ghost" style={{ marginTop: '0.4rem' }} onClick={() => setHistoryDetail({ sub, quiz: q! })}>查看答卷</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div>
        <h1>随堂测验 / 作业</h1>
        <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
          <p className="muted">输入老师给出的 4 位密码进入测验或作业。</p>
          <div className="row" style={{ marginTop: '0.8rem', gap: '0.5rem' }}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="4 位密码"
              inputMode="numeric"
              style={{ flex: 1, textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.3em' }}
              onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }}
              autoFocus
            />
            <button className="primary" onClick={lookup} disabled={busy}>{busy ? '…' : '进入'}</button>
          </div>
          {error && <p className="gate-error" style={{ marginTop: '0.6rem' }}>{error}</p>}
          <div style={{ marginTop: '0.8rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem', textAlign: 'center' }}>
            <button className="ghost" onClick={openHistory} disabled={historyLoading}>{historyLoading ? '加载中…' : '查看历史结果'}</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'confirm' && quiz) {
    return (
      <div>
        <h1>{quiz.title}</h1>
        <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
          <p className="muted" style={{ margin: 0 }}>{KIND_LABELS[quiz.kind]}</p>
          <div className="grid cols-2" style={{ marginTop: '0.6rem' }}>
            <div className="stat"><span className="num">{quiz.question_count}</span><span className="label">题数</span></div>
            <div className="stat"><span className="num">{formatDuration(quiz.duration_minutes)}</span><span className="label">限时</span></div>
          </div>
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.6rem' }}>
            题型：{quiz.question_types.map((t) => TYPE_LABELS[t as keyof typeof TYPE_LABELS]).join('、')}
          </p>
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.3rem' }}>
            进入后开始计时，交卷前请勿离开页面（切屏/失焦会被记录）。
          </p>
          {quiz.allow_resume && (
            <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.3rem' }}>
              作业模式：可随时「保存并退出」，之后凭密码回来继续。
            </p>
          )}
          {resumed && <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.3rem' }}>检测到上次未完成的作答，已为你恢复进度。</p>}
          {error && <p className="gate-error" style={{ marginTop: '0.6rem' }}>{error}</p>}
          {!authUser ? (
            <p className="gate-error" style={{ marginTop: '0.8rem' }}>请先登录后再参加随堂测验/作业（离线游客无法作答）。</p>
          ) : (
            <button className="primary" onClick={begin} disabled={busy} style={{ marginTop: '0.8rem' }}>
              {busy ? '请稍候…' : '开始答题'}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'done' && quiz) {
    return (
      <div className="card center" style={{ maxWidth: 480, margin: '0 auto' }}>
        <h2>交卷成功</h2>
        <p className="muted">{quiz.title}</p>
        <p className="big" style={{ fontSize: '2rem' }}>{score} / {quiz.question_count}</p>
        <p className="muted">老师可在后台查看你的成绩。</p>
        <button className="primary" onClick={() => { setPhase('enter'); setQuiz(null); setCode(''); setAnswers({}); setQi(0); setSubmitted(false); setScore(null); }}>
          返回
        </button>
      </div>
    );
  }

  // taking
  const q = questions[qi];
  if (!q) {
    // 理论上不会到这里（超时/交卷会切走），兜底显示
    return <div className="card center"><p className="muted">加载中…</p></div>;
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem', alignItems: 'center' }}>
        <span className="muted">第 {qi + 1} / {questions.length} 题</span>
        <span className="spacer" />
        {leaveCount > 0 && <span className="badge danger" title="切屏/失焦次数">离开 {leaveCount}</span>}
        <span className={`badge ${remaining < 60 || pastDue ? 'danger' : 'success'}`}>
          {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
        </span>
      </div>

      {pastDue && (
        <div className="card" style={{ marginBottom: '0.5rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
          已过提交截止时间，无法交卷。本次作答不会计入成绩。
        </div>
      )}

      <div className="card">
        <div className="muted" style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span>{TYPE_LABELS[q.type]}</span>
          {q.type !== 'matching' && (
            <span className={`badge ${q.itemType === 'term' ? 'success' : 'warn'}`}>{q.itemType === 'term' ? '术语' : '学者'}</span>
          )}
          <span>根据{q.promptLabel}作答</span>
        </div>
        <h2 style={{ margin: '0.5rem 0 1rem' }}>{q.prompt}</h2>

        {q.type === 'spelling' && (
          <SpellingAnswer key={q.id} q={q} value={answers[q.itemId]} onChange={setAnswer} onNext={() => setQi((i) => i + 1)} isLast={qi === questions.length - 1} onSubmit={() => doSubmit()} />
        )}

        {q.type === 'choice' && q.options && (
          <ChoiceAnswer key={q.id} q={q} value={answers[q.itemId]} onChange={setAnswer} onNext={() => setQi((i) => i + 1)} isLast={qi === questions.length - 1} onSubmit={() => doSubmit()} />
        )}

        {q.type === 'matching' && (
          <MatchingAnswer
            key={q.id}
            q={q}
            answers={answers}
            onPair={(termId, defId) => setAnswers((prev) => ({ ...prev, [termId]: defId }))}
            onUnpair={(termId) => setAnswers((prev) => { const next = { ...prev }; delete next[termId]; return next; })}
            onNext={() => setQi((i) => i + 1)}
            isLast={qi === questions.length - 1}
            onSubmit={() => doSubmit()}
          />
        )}
      </div>

      {error && (
        <div className="card" style={{ marginTop: '0.8rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
          {error}
        </div>
      )}
      <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'space-between' }}>
        <button className="ghost" onClick={() => setQi((i) => Math.max(0, i - 1))} disabled={qi === 0}>上一题</button>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {quiz?.allow_resume && (
            <button className="ghost" onClick={saveAndExit} disabled={busy}>保存并退出</button>
          )}
          <button className="primary" onClick={() => doSubmit()} disabled={submitted || busy || pastDue}>{busy ? '交卷中…' : '交卷'}</button>
        </div>
      </div>
    </div>
  );
}

// ---- 各题型作答子组件 ----

function SpellingAnswer({ q, value, onChange, onNext, isLast, onSubmit }: {
  q: QuizQuestion; value: string | number | undefined; onChange: (v: string | number) => void;
  onNext: () => void; isLast: boolean; onSubmit: () => void;
}) {
  const [input, setInput] = useState(String(value ?? ''));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  // 输入即实时同步到父组件 answers，避免「输入了答案却点全局交卷按钮」导致漏判为未作答
  const handleChange = (v: string) => {
    setInput(v);
    onChange(v);
  };
  const commit = () => {
    if (isLast) onSubmit(); else onNext();
  };
  return (
    <div>
      {q.chinese && <p className="muted" style={{ fontSize: '0.9rem' }}>中文：{q.chinese}</p>}
      <p className="muted" style={{ fontSize: '0.9rem' }}>释义提示：{q.definition}</p>
      <div className="row" style={{ marginTop: '0.8rem', gap: '0.5rem' }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          placeholder="输入英文术语…"
          autoComplete="off"
          style={{ flex: 1 }}
        />
        <button className="primary" onClick={commit}>{isLast ? '交卷' : '下一题 →'}</button>
      </div>
    </div>
  );
}

function ChoiceAnswer({ q, value, onChange, onNext, isLast, onSubmit }: {
  q: QuizQuestion; value: string | number | undefined; onChange: (v: string | number) => void;
  onNext: () => void; isLast: boolean; onSubmit: () => void;
}) {
  const picked = value === undefined ? null : Number(value);
  // 学生端对选项再做一次乱序（用当前已固定的选项集，但这里保持题库快照顺序即可，已足够防作弊）
  return (
    <div>
      <div className="grid" style={{ gap: '0.5rem' }}>
        {q.options!.map((opt, idx) => (
          <button
            key={idx}
            className={`option-btn ${picked === idx ? 'selected' : ''}`}
            onClick={() => onChange(idx)}
          >
            <span className="mark">{String.fromCharCode(65 + idx)}</span>
            <span>{opt}</span>
          </button>
        ))}
      </div>
      <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
        <button className="primary" onClick={() => { if (picked === null) return; if (isLast) onSubmit(); else onNext(); }} disabled={picked === null}>
          {isLast ? '交卷' : '下一题 →'}
        </button>
      </div>
    </div>
  );
}

function MatchingAnswer({ q, answers, onPair, onUnpair, onNext, isLast, onSubmit }: {
  q: QuizQuestion;
  answers: Record<string, string | number>;
  onPair: (termId: string, defId: string) => void;
  onUnpair: (termId: string) => void;
  onNext: () => void; isLast: boolean; onSubmit: () => void;
}) {
  const pairs = q.pairs ?? [];
  const [rightOrder] = useState<number[]>(() => shuffle(pairs.map((_, i) => i)));
  const [selLeft, setSelLeft] = useState<string | null>(null);
  const [selRight, setSelRight] = useState<string | null>(null);
  const onPairRef = useRef(onPair);
  useEffect(() => { onPairRef.current = onPair; }, [onPair]);

  // 已配对的术语（answers 里有记录的 key）
  const pairedTermIds = new Set(pairs.filter((p) => answers[p.itemId] !== undefined && answers[p.itemId] !== '').map((p) => p.itemId));
  // 已被配对到的释义（answers 的 value 里出现的 itemId）
  const answerValues = new Set(Object.values(answers).map(String));
  const pairedDefIds = new Set(pairs.filter((p) => answerValues.has(p.itemId)).map((p) => p.itemId));

  // 配对编号：术语与其配对的释义显示相同序号（体现配对关系，而非对错判定）
  const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  const numberByTermId = new Map<string, number>();
  const numberByDefId = new Map<string, number>();
  {
    let n = 0;
    for (const p of pairs) {
      const defId = answers[p.itemId];
      if (defId !== undefined && defId !== '') {
        numberByTermId.set(p.itemId, n);
        numberByDefId.set(String(defId), n);
        n++;
      }
    }
  }

  // 两侧都选中后配对（无论对错都记录，允许提交错误答案）
  useEffect(() => {
    if (!selLeft || !selRight) return;
    onPairRef.current(selLeft, selRight);
    setSelLeft(null);
    setSelRight(null);
  }, [selLeft, selRight]);

  // 点击已配对的项 = 取消配对重新选；未配对的 = 选中待配
  const clickLeft = (termId: string) => {
    if (pairedTermIds.has(termId)) {
      onUnpair(termId);
      return;
    }
    setSelLeft((prev) => (prev === termId ? null : termId));
  };
  const clickRight = (defId: string) => {
    if (pairedDefIds.has(defId)) {
      const termId = pairs.find((p) => answers[p.itemId] === defId)?.itemId;
      if (termId) onUnpair(termId);
      return;
    }
    setSelRight((prev) => (prev === defId ? null : defId));
  };

  const allPaired = pairedTermIds.size === pairs.length;

  return (
    <div>
      <div className="grid cols-2" style={{ gap: '0.8rem' }}>
        <div>
          <h3 className="muted" style={{ fontSize: '0.85rem', margin: '0 0 0.4rem' }}>术语</h3>
          <div className="grid" style={{ gap: '0.4rem' }}>
            {pairs.map((p) => {
              const done = pairedTermIds.has(p.itemId);
              const selected = selLeft === p.itemId;
              const num = numberByTermId.get(p.itemId);
              return (
                <button
                  key={p.itemId}
                  className="option-btn"
                  onClick={() => clickLeft(p.itemId)}
                  style={{
                    background: selected ? 'var(--accent-bg)' : undefined,
                    borderColor: done ? 'var(--accent)' : selected ? 'var(--accent)' : undefined,
                  }}
                >
                  <span>{p.term}</span>
                  {done && num !== undefined && <span style={{ marginLeft: '0.4rem', color: 'var(--accent)' }}>{CIRCLED[num]}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <h3 className="muted" style={{ fontSize: '0.85rem', margin: '0 0 0.4rem' }}>释义</h3>
          <div className="grid" style={{ gap: '0.4rem' }}>
            {rightOrder.map((i) => {
              const p = pairs[i];
              const done = pairedDefIds.has(p.itemId);
              const selected = selRight === p.itemId;
              const num = numberByDefId.get(p.itemId);
              return (
                <button
                  key={p.itemId}
                  className="option-btn"
                  onClick={() => clickRight(p.itemId)}
                  style={{
                    background: selected ? 'var(--accent-bg)' : undefined,
                    borderColor: done ? 'var(--accent)' : selected ? 'var(--accent)' : undefined,
                    fontSize: '0.88rem',
                  }}
                >
                  <span>{p.definition}</span>
                  {done && num !== undefined && <span style={{ marginLeft: '0.4rem', color: 'var(--accent)' }}>{CIRCLED[num]}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
        {selLeft && !selRight
          ? '已选择左侧术语，请点击右侧对应释义'
          : selRight && !selLeft
          ? '已选择右侧释义，请点击左侧对应术语'
          : '点击术语与释义配对（相同序号即为一对），全部配完即可继续；点击已配对的项可取消重配'}
      </p>
      <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
        <button className="primary" onClick={() => { if (isLast) onSubmit(); else onNext(); }} disabled={!allPaired}>
          {allPaired ? (isLast ? '交卷' : '下一题 →') : `已配对 ${pairedTermIds.size}/${pairs.length}`}
        </button>
      </div>
    </div>
  );
}

// 历史结果 · 单份答卷详情
function HistoryDetail({ detail, onBack }: {
  detail: { sub: QuizSubmission; quiz: Quiz };
  onBack: () => void;
}) {
  const { sub, quiz } = detail;
  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: '0.6rem' }}>
        <button className="ghost" onClick={onBack}>← 返回列表</button>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: '0.85rem' }}>{sub.score} / {quiz.question_count} 分</span>
      </div>
      <h3 style={{ margin: '0 0 0.6rem' }}>{quiz.title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {quiz.questions.map((q, idx) => {
          // 匹配块：按对展示配对结果
          if (q.type === 'matching' && q.pairs) {
            const answers = sub.answers ?? {};
            const correct = matchingCorrectCount(q, answers);
            const total = q.pairs.length;
            const allOk = correct === total;
            return (
              <div
                key={q.id}
                style={{
                  border: `1px solid ${allOk ? 'var(--success)' : 'var(--danger)'}`,
                  borderRadius: '0.4rem',
                  padding: '0.5rem 0.7rem',
                  background: allOk ? 'var(--success-bg)' : 'var(--danger-bg)',
                }}
              >
                <div className="row" style={{ alignItems: 'center', gap: '0.5rem' }}>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>#{idx + 1} · 匹配</span>
                  <span className="spacer" />
                  <span style={{ fontWeight: 700, color: allOk ? 'var(--success)' : 'var(--danger)' }}>
                    {correct} / {total} 对正确
                  </span>
                </div>
                <div style={{ marginTop: '0.2rem', fontWeight: 600 }}>{q.prompt}</div>
                <div style={{ marginTop: '0.3rem', fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  {q.pairs.map((p) => {
                    const pairedOk = answers[p.itemId] === p.itemId;
                    return (
                      <div key={p.itemId} style={{ color: pairedOk ? 'var(--success)' : 'var(--danger)' }}>
                        <span style={{ fontWeight: 600 }}>{p.term}</span>
                        <span style={{ color: 'inherit' }}> → {p.definition}</span>
                        <span>{pairedOk ? ' ✓' : ' ✗'}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }
          const a = sub.answers?.[q.itemId];
          const ok = isAnswerCorrect(q, a);
          return (
            <div
              key={q.id}
              style={{
                border: `1px solid ${ok ? 'var(--success)' : 'var(--danger)'}`,
                borderRadius: '0.4rem',
                padding: '0.5rem 0.7rem',
                background: ok ? 'var(--success-bg)' : 'var(--danger-bg)',
              }}
            >
              <div className="row" style={{ alignItems: 'center', gap: '0.5rem' }}>
                <span className="muted" style={{ fontSize: '0.8rem' }}>#{idx + 1} · {TYPE_LABELS[q.type]}</span>
                <span className="spacer" />
                <span style={{ fontWeight: 700, color: ok ? 'var(--success)' : 'var(--danger)' }}>{ok ? '✓ 正确' : '✗ 错误'}</span>
              </div>
              <div style={{ marginTop: '0.2rem', fontWeight: 600 }}>{q.prompt}</div>
              {!ok && (
                <div style={{ marginTop: '0.3rem', fontSize: '0.85rem' }}>
                  <div>我的作答：<span style={{ color: 'var(--danger)' }}>{answerText(q, a) || '（未作答）'}</span></div>
                  <div>正确答案：<span style={{ color: 'var(--success)' }}>{correctAnswerText(q)}</span></div>
                </div>
              )}
              {ok && (
                <div style={{ marginTop: '0.3rem', fontSize: '0.85rem', color: 'var(--success)' }}>
                  作答：{answerText(q, a) || correctAnswerText(q)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
