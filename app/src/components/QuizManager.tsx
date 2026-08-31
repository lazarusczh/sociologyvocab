import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import type { VocabItem, Quiz, QuizSubmission, QuizQuestionType, QuizKind } from '../lib/types';
import { buildQuizQuestions, sampleItems, TYPE_LABELS, KIND_LABELS, formatDuration, isAnswerCorrect, answerText, correctAnswerText, totalPoints, matchingCorrectCount } from '../lib/quiz';
import { PAPER_ORDER } from '../lib/storage';
import { unitListFor } from '../lib/unitMapping';
import { maskEmail } from '../lib/shuffle';
import { createQuiz, updateQuiz, listQuizzes, listQuizSubmissions, deleteQuiz, listDeveloperIds, deleteSubmission, countSubmittedByQuizzes } from '../lib/cloud';

// 创建表单草稿
interface Draft {
  kind: QuizKind;
  title: string;
  selectionMode: 'random' | 'manual';
  paper: string;          // 'all' 或 'Paper N'
  cat: string;            // 次级标签
  unit: string;           // 单元
  typeFilter: 'all' | 'term' | 'scholar'; // 类型筛选
  questionCount: number;  // 题量（random 模式）
  durationMinutes: number;
  questionTypes: QuizQuestionType[];
  manualIds: string[];    // 手动勾选的词条 id
  openAt: string;         // 统一开考时间（'' = 随时可进）
  dueAt: string;          // 作业截止时间
  allowLate: boolean;     // 作业：允许迟交（迟交按罚分规则扣分）
  lateEnabled: boolean;   // 迟交罚分是否启用
  latePercents: string;   // 每迟一天追加的百分比（逗号分隔，如 "10,20,30,40"）
}

const ALL_TYPES: QuizQuestionType[] = ['spelling', 'choice', 'matching'];

// 教师默认评分规则（localStorage）：创建作业时快照进 quizzes.grading_rules
const GRADING_RULES_KEY = 'socio_vocab_grading_rules';
const DEFAULT_LATE_PERCENTS = '10,20,30,40';

// 解析逗号分隔的百分比字符串 → 数字数组（非法值过滤；空则返回空数组）
function parsePercents(s: string): number[] {
  return s
    .split(/[,，]/)
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

// 构建 grading_rules 对象（供创建/更新时快照）
function buildGradingRules(lateEnabled: boolean, percentsStr: string) {
  return {
    late_penalty: {
      enabled: lateEnabled,
      daily_percents: parsePercents(percentsStr),
    },
  };
}

function loadDefaultPercents(): string {
  try {
    return localStorage.getItem(GRADING_RULES_KEY) ?? DEFAULT_LATE_PERCENTS;
  } catch {
    return DEFAULT_LATE_PERCENTS;
  }
}
function saveDefaultPercents(s: string): void {
  try { localStorage.setItem(GRADING_RULES_KEY, s); } catch { /* ignore */ }
}

// 暂存草稿（localStorage）：保存教师未完成填写的表单，可稍后恢复继续编辑
const DRAFT_KEY = 'socio_vocab_quiz_draft';
interface SavedDraft {
  draft: Draft;
  editingId: string | null;
  savedAt: number;
}

// 把已有 Quiz 转成编辑草稿（编辑时预填）
function toDraft(q: Quiz): Draft {
  return {
    kind: q.kind,
    title: q.title,
    selectionMode: q.selection_mode,
    paper: q.papers.length ? q.papers[0] : 'all',
    cat: q.category ?? 'all',
    unit: q.units.length ? q.units[0] : 'all',
    typeFilter: q.type_filter ?? 'all',
    questionCount: q.question_count,
    durationMinutes: q.duration_minutes,
    questionTypes: q.question_types,
    manualIds: q.selection_mode === 'manual' ? [...new Set(q.questions.map((x) => x.itemId))] : [],
    openAt: q.open_at ? toLocalInput(q.open_at) : '',
    dueAt: q.due_at ? toLocalInput(q.due_at) : '',
    allowLate: q.allow_late ?? false,
    lateEnabled: (q.grading_rules as { late_penalty?: { enabled?: boolean } } | null)?.late_penalty?.enabled ?? true,
    latePercents: ((q.grading_rules as { late_penalty?: { daily_percents?: number[] } } | null)?.late_penalty?.daily_percents ?? [10, 20, 30, 40]).join(','),
  };
}

// ISO 时间 → datetime-local 输入框需要的本地时间字符串
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function QuizManager() {
  const { vocab, authUser, unitOrder } = useStore();
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Quiz | null>(null); // 正在查看成绩的试卷
  const [subs, setSubs] = useState<QuizSubmission[]>([]);
  const [submissionCounts, setSubmissionCounts] = useState<Record<string, number>>({});
  const [detailUser, setDetailUser] = useState<string | null>(null); // 正在查看答卷详情的学生 user_id
  const [devIds, setDevIds] = useState<Set<string>>(new Set()); // developer 账户 user_id（识别测试记录）
  const [manualSearch, setManualSearch] = useState(''); // 手动勾选词条的检索词
  const [pendingDraft, setPendingDraft] = useState<SavedDraft | null>(null); // 启动时检测到的暂存草稿

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = await listQuizzes();
      setQuizzes(qs);
      if (qs.length > 0) {
        setSubmissionCounts(await countSubmittedByQuizzes(qs.map((q) => q.id)));
      } else {
        setSubmissionCounts({});
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 启动时检测是否有暂存草稿
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) setPendingDraft(JSON.parse(raw) as SavedDraft);
    } catch {
      // 草稿损坏则忽略
    }
  }, []);

  // 暂存草稿
  const saveDraft = () => {
    if (!draft) return;
    const saved: SavedDraft = { draft, editingId, savedAt: Date.now() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(saved));
    setMsg('已暂存草稿，可稍后继续编辑');
  };

  // 清除草稿
  const clearDraft = () => {
    localStorage.removeItem(DRAFT_KEY);
    setPendingDraft(null);
  };

  // 恢复草稿
  const restoreDraft = () => {
    if (!pendingDraft) return;
    setDraft(pendingDraft.draft);
    setEditingId(pendingDraft.editingId);
    clearDraft();
    setMsg('已恢复暂存的草稿');
  };

  const startCreate = () => {
    setDraft({
      kind: 'quiz',
      title: '',
      selectionMode: 'random',
      paper: 'all',
      cat: 'all',
      unit: 'all',
      typeFilter: 'all',
      questionCount: 10,
      durationMinutes: 20,
      questionTypes: ['spelling', 'choice'],
      manualIds: [],
      openAt: '',
      dueAt: '',
      allowLate: false,
      lateEnabled: true,
      latePercents: loadDefaultPercents(),
    });
    setEditingId(null);
    setMsg('');
    setError('');
  };

  const startEdit = (q: Quiz) => {
    setDraft(toDraft(q));
    setEditingId(q.id);
    setMsg('');
    setError('');
  };

  // random 模式可选范围
  const paperItems = useMemo(
    () => (draft ? vocab.filter((i) =>
      (draft.paper === 'all' || i.paper === draft.paper) &&
      (draft.typeFilter === 'all' || i.type === draft.typeFilter),
    ) : []),
    [vocab, draft?.paper, draft?.typeFilter],
  );
  const subLabels = useMemo(() => {
    if (!draft || draft.paper === 'all') return [];
    return [...new Set(paperItems.map((i) => i.category).filter(Boolean))];
  }, [draft?.paper, paperItems]);
  const units = useMemo(() => {
    if (!draft) return [];
    return unitListFor(vocab, draft.paper, draft.cat, unitOrder);
  }, [draft?.paper, draft?.cat, vocab, unitOrder]);

  // 干扰项来源池：按类型筛选，保证术语题的干扰项不混入学者（反之亦然）
  const typePool = useMemo(
    () => (draft && draft.typeFilter !== 'all' ? vocab.filter((i) => i.type === draft.typeFilter) : vocab),
    [vocab, draft?.typeFilter],
  );

  // 手动模式下的候选词条（按 paper/cat/unit/类型 筛选 + 检索词过滤）
  const manualCandidates = useMemo(() => {
    if (!draft) return [];
    const kw = manualSearch.trim();
    const kwLower = kw.toLowerCase();
    return vocab.filter((i) => {
      if (draft.paper !== 'all' && i.paper !== draft.paper) return false;
      if (draft.cat !== 'all' && i.category !== draft.cat) return false;
      if (draft.unit !== 'all' && !(i.unit ?? []).includes(draft.unit)) return false;
      if (draft.typeFilter !== 'all' && i.type !== draft.typeFilter) return false;
      if (kw) {
        const hitTerm = i.term.toLowerCase().includes(kwLower);
        const hitChinese = (i.chinese || '').includes(kw);
        const hitDef = i.definition.toLowerCase().includes(kwLower);
        if (!hitTerm && !hitChinese && !hitDef) return false;
      }
      return true;
    });
  }, [draft?.paper, draft?.cat, draft?.unit, draft?.typeFilter, vocab, manualSearch]);

  const toggleType = (t: QuizQuestionType) => {
    setDraft((d) => {
      if (!d) return d;
      const has = d.questionTypes.includes(t);
      const next = has ? d.questionTypes.filter((x) => x !== t) : [...d.questionTypes, t];
      return { ...d, questionTypes: next };
    });
  };

  const toggleManual = (id: string) => {
    setDraft((d) => {
      if (!d) return d;
      const has = d.manualIds.includes(id);
      return { ...d, manualIds: has ? d.manualIds.filter((x) => x !== id) : [...d.manualIds, id] };
    });
  };

  const submit = async () => {
    if (!draft) return;
    setError('');
    setMsg('');
    if (!draft.title.trim()) { setError('请填写标题'); return; }
    if (draft.questionTypes.length === 0) { setError('请至少勾选一种题型'); return; }

    let items: VocabItem[];
    if (draft.selectionMode === 'random') {
      if (draft.questionCount < 1) { setError('题量至少为 1'); return; }
      items = sampleItems(paperItems, draft.questionCount);
      if (items.length === 0) { setError('该范围内没有可用词条'); return; }
    } else {
      items = vocab.filter((i) => draft.manualIds.includes(i.id));
      if (items.length === 0) { setError('请手动勾选至少一个词条'); return; }
    }

    const questions = buildQuizQuestions(items, draft.questionTypes, typePool);
    const payload = {
      title: draft.title.trim(),
      kind: draft.kind,
      selection_mode: draft.selectionMode,
      papers: draft.paper === 'all' ? [] : [draft.paper],
      category: draft.cat === 'all' ? null : draft.cat,
      units: draft.unit === 'all' ? [] : [draft.unit],
      type_filter: draft.typeFilter,
      question_count: totalPoints(questions),
      duration_minutes: draft.durationMinutes,
      question_types: draft.questionTypes,
      questions,
      open_at: draft.openAt ? new Date(draft.openAt).toISOString() : null,
      due_at: draft.dueAt ? new Date(draft.dueAt).toISOString() : null,
      allow_resume: draft.kind === 'homework',
      allow_late: draft.kind === 'homework' && draft.allowLate,
      // 评分规则快照：仅作业携带（测验无罚分）；创建时同时记忆教师默认规则
      grading_rules: draft.kind === 'homework' ? buildGradingRules(draft.lateEnabled, draft.latePercents) : null,
    };
    if (draft.kind === 'homework') saveDefaultPercents(draft.latePercents);
    try {
      if (editingId) {
        await updateQuiz(editingId, payload);
        setMsg(`已保存「${draft.title.trim()}」的修改`);
      } else {
        const code = await createQuiz({ ...payload, created_by: authUser?.id ?? null });
        setMsg(`已创建「${draft.title.trim()}」，密码：${code}（请告知学生）`);
      }
      setDraft(null);
      setEditingId(null);
      clearDraft();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const viewSubmissions = async (q: Quiz) => {
    setViewing(q);
    setError('');
    try {
      setSubs(await listQuizSubmissions(q.id));
      setDevIds(new Set(await listDeveloperIds()));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 删除某条答题记录（RLS 限制：仅 developer 账户的记录可删）
  const removeSubmission = async (id: string) => {
    if (!window.confirm('确认删除这条答题记录？')) return;
    setError('');
    try {
      await deleteSubmission(id);
      setSubs((prev) => prev.filter((s) => s.id !== id));
      setDetailUser(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (q: Quiz) => {
    try {
      await deleteQuiz(q.id);
      setConfirmingDelete(null);
      refresh();
      if (viewing?.id === q.id) setViewing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (viewing) {
    const detailSubmission = detailUser ? subs.find((s) => s.user_id === detailUser) : null;
    return (
      <div>
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <button className="ghost" onClick={() => setViewing(null)}>← 返回</button>
            <h3 style={{ margin: 0 }}>成绩：{viewing.title}</h3>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: '0.85rem' }}>密码 {viewing.code} · 共 {viewing.question_count} 题</span>
          </div>
        </div>
        {error && <div className="card" style={{ marginBottom: '0.8rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>{error}</div>}
        {subs.length === 0 ? (
          <div className="card"><div className="empty-state"><p className="muted">暂无学生交卷。</p></div></div>
        ) : (
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="check-table">
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>邮箱</th>
                  <th>得分</th>
                  <th>状态</th>
                  <th>切屏次数</th>
                  <th>离开时长</th>
                  <th>交卷时间</th>
                  <th>答卷</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name || '—'}</td>
                    <td className="muted">{s.email ? maskEmail(s.email) : '—'}</td>
                    <td>
                      {s.score} / {viewing.question_count}
                      {s.grading?.penalty != null && s.grading.penalty > 0 && (
                        <span className="muted" style={{ fontSize: '0.75rem', marginLeft: '0.3rem' }} title={`迟交 ${s.grading.late_days ?? 1} 天罚 ${s.grading.penalty} 分`}>
                          → {s.grading.final_score}
                        </span>
                      )}
                    </td>
                    <td>{s.status === 'submitted' ? '已交卷' : '进行中'}</td>
                    <td>{s.leave_count}</td>
                    <td>{s.leave_seconds}s</td>
                    <td className="muted" style={{ fontSize: '0.8rem' }}>{s.submitted_at ? new Date(s.submitted_at).toLocaleString() : '—'}</td>
                    <td>
                      <button onClick={() => setDetailUser(detailUser === s.user_id ? null : s.user_id)}>
                        {detailUser === s.user_id ? '收起' : '查看'}
                      </button>
                      {devIds.has(s.user_id) && (
                        <button className="danger" onClick={() => removeSubmission(s.id)} style={{ marginLeft: '0.4rem' }}>
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {detailSubmission && (
          <div className="card" style={{ marginTop: '0.8rem' }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>答卷：{detailSubmission.name || (detailSubmission.email ? maskEmail(detailSubmission.email) : '—')}</h3>
              <span className="spacer" />
              <span className="muted" style={{ fontSize: '0.85rem' }}>
                {detailSubmission.score} / {viewing.question_count} 分
                {detailSubmission.grading?.penalty != null && detailSubmission.grading.penalty > 0 && (
                  <span style={{ color: 'var(--warn, #a07a3a)' }}>
                    {' '}（迟交 {detailSubmission.grading.late_days ?? 1} 天罚 {detailSubmission.grading.penalty} 分，最终 {detailSubmission.grading.final_score}）
                  </span>
                )}
              </span>
            </div>
            <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {viewing.questions.map((q, idx) => {
                // 匹配块：按对展示配对结果
                if (q.type === 'matching' && q.pairs) {
                  const answers = detailSubmission.answers ?? {};
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
                              <span className="muted" style={{ color: 'inherit' }}> → {p.definition}</span>
                              <span>{pairedOk ? ' ✓' : ' ✗'}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                }
                const a = detailSubmission.answers?.[q.itemId];
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
                        <div>学生作答：<span style={{ color: 'var(--danger)' }}>{answerText(q, a) || '（未作答）'}</span></div>
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
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>随堂测验 / 作业</h3>
          <span className="spacer" />
          <button className="ghost" onClick={refresh} disabled={loading}>{loading ? '加载中…' : '刷新'}</button>
          <button className="primary" onClick={startCreate}>+ 创建</button>
        </div>
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          生成测验或作业，得到 4 位密码告知学生。学生凭密码进入作答，交卷后此处查看成绩。
        </p>
        {error && <div className="card" style={{ marginTop: '0.6rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>{error}</div>}
        {msg && <div className="card" style={{ marginTop: '0.6rem', background: 'var(--ok-bg)', borderColor: 'var(--ok)' }}>{msg}</div>}
        {pendingDraft && !draft && (
          <div className="card" style={{ marginTop: '0.6rem', background: 'var(--accent-bg)', borderColor: 'var(--accent)' }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <span>有暂存的测验草稿（保存于 {new Date(pendingDraft.savedAt).toLocaleString()}）</span>
              <span className="spacer" />
              <button className="primary" onClick={restoreDraft}>恢复草稿</button>
              <button onClick={clearDraft}>放弃</button>
            </div>
          </div>
        )}
      </div>

      {draft && (
        <div className="card" style={{ marginBottom: '0.8rem', borderColor: 'var(--accent)' }}>
          <h3>{editingId ? '编辑测验 / 作业' : '创建测验 / 作业'}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginTop: '0.6rem' }}>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>类型</span>
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as QuizKind })}>
                <option value="quiz">随堂测验（严格限时）</option>
                <option value="homework">作业（放宽时限，可保存退出）</option>
              </select>
            </label>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>标题</span>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="如：Unit 1 随堂测验" />
            </label>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>选题方式</span>
              <select value={draft.selectionMode} onChange={(e) => setDraft({ ...draft, selectionMode: e.target.value as 'random' | 'manual' })}>
                <option value="random">随机抽题（按范围）</option>
                <option value="manual">手动指定词条</option>
              </select>
            </label>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>限时（分钟）</span>
              <input type="number" min={1} value={draft.durationMinutes} onChange={(e) => setDraft({ ...draft, durationMinutes: Math.max(1, Number(e.target.value)) })} />
            </label>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>统一开考时间（可空 = 随时可进）</span>
              <input type="datetime-local" value={draft.openAt} onChange={(e) => setDraft({ ...draft, openAt: e.target.value })} />
            </label>
            <label>
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                {draft.kind === 'homework' ? '截止时间 / 结果公布（可空 = 立即可见）' : '结果公布时间（可空 = 交卷后立即可见）'}
              </span>
              <input type="datetime-local" value={draft.dueAt} onChange={(e) => setDraft({ ...draft, dueAt: e.target.value })} />
            </label>
          </div>

          {draft.kind === 'homework' && (
            <div className="card" style={{ marginTop: '0.6rem', padding: '0.6rem 0.8rem' }}>
              <span className="muted" style={{ fontSize: '0.8rem' }}>迟交与评分规则（仅作业）</span>
              <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <label className="row" style={{ alignItems: 'center', gap: '0.4rem' }}>
                  <input
                    type="checkbox"
                    checked={draft.allowLate}
                    onChange={(e) => setDraft({ ...draft, allowLate: e.target.checked })}
                    style={{ margin: 0, width: '1rem', height: '1rem' }}
                  />
                  <span style={{ fontSize: '0.85rem' }}>
                    允许迟交（过了截止仍可交卷，按迟交天数累积百分比罚分；测验不支持）
                  </span>
                </label>
                <label className="row" style={{ alignItems: 'center', gap: '0.4rem' }}>
                  <input
                    type="checkbox"
                    checked={draft.lateEnabled}
                    onChange={(e) => setDraft({ ...draft, lateEnabled: e.target.checked })}
                    style={{ margin: 0, width: '1rem', height: '1rem' }}
                  />
                  <span style={{ fontSize: '0.85rem' }}>启用迟交罚分</span>
                </label>
                <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    每迟一天追加的百分比
                  </span>
                  <input
                    type="text"
                    value={draft.latePercents}
                    onChange={(e) => setDraft({ ...draft, latePercents: e.target.value })}
                    placeholder={DEFAULT_LATE_PERCENTS}
                    style={{ maxWidth: '14rem' }}
                  />
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setDraft({ ...draft, latePercents: DEFAULT_LATE_PERCENTS })}
                  >
                    恢复默认
                  </button>
                </div>
                <p className="muted" style={{ fontSize: '0.75rem' }}>
                  逗号分隔：第 1 天追加第 1 个数、第 2 天追加第 2 个……依此类推；超出部分沿用最后一个数；累积封顶 100%。
                </p>
              </div>
            </div>
          )}

          <div style={{ marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.8rem' }}>题型（均匀随机分配）</span>
            <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
              {ALL_TYPES.map((t) => (
                <button key={t} className={draft.questionTypes.includes(t) ? 'active' : ''} onClick={() => toggleType(t)}>{TYPE_LABELS[t]}</button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.8rem' }}>范围筛选</span>
            <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
              <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>类型：</span>
              <button className={draft.typeFilter === 'all' ? 'active' : ''} onClick={() => setDraft({ ...draft, typeFilter: 'all' })}>全部</button>
              <button className={draft.typeFilter === 'term' ? 'active' : ''} onClick={() => setDraft({ ...draft, typeFilter: 'term' })}>术语</button>
              <button className={draft.typeFilter === 'scholar' ? 'active' : ''} onClick={() => setDraft({ ...draft, typeFilter: 'scholar' })}>学者</button>
            </div>
            <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
              <button className={draft.paper === 'all' ? 'active' : ''} onClick={() => setDraft({ ...draft, paper: 'all', cat: 'all', unit: 'all' })}>全部考卷</button>
              {PAPER_ORDER.map((p) => (
                <button key={p} className={draft.paper === p ? 'active' : ''} onClick={() => setDraft({ ...draft, paper: p, cat: 'all', unit: 'all' })}>{p}</button>
              ))}
            </div>
            {subLabels.length > 1 && (
              <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
                <button className={draft.cat === 'all' ? 'active' : ''} onClick={() => setDraft({ ...draft, cat: 'all', unit: 'all' })}>全部主题</button>
                {subLabels.map((c) => (
                  <button key={c} className={draft.cat === c ? 'active' : ''} onClick={() => setDraft({ ...draft, cat: c, unit: 'all' })}>{c}</button>
                ))}
              </div>
            )}
            {units.length > 0 && (
              <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
                <button className={draft.unit === 'all' ? 'active' : ''} onClick={() => setDraft({ ...draft, unit: 'all' })}>全部单元</button>
                {units.map((u) => (
                  <button key={u} className={draft.unit === u ? 'active' : ''} onClick={() => setDraft({ ...draft, unit: u })}>{u}</button>
                ))}
              </div>
            )}
          </div>

          {draft.selectionMode === 'random' ? (
            <label style={{ display: 'block', marginTop: '0.6rem' }}>
              <span className="muted" style={{ fontSize: '0.8rem' }}>题量（当前范围共 {paperItems.length} 条）</span>
              <input type="number" min={1} max={paperItems.length} value={draft.questionCount} onChange={(e) => setDraft({ ...draft, questionCount: Math.max(1, Number(e.target.value)) })} style={{ maxWidth: '10rem' }} />
            </label>
          ) : (
            <div style={{ marginTop: '0.6rem' }}>
              <span className="muted" style={{ fontSize: '0.8rem' }}>勾选词条（已选 {draft.manualIds.length} 条）</span>
              <input
                type="text"
                placeholder="检索术语 / 中文 / 释义…"
                value={manualSearch}
                onChange={(e) => setManualSearch(e.target.value)}
                style={{ marginTop: '0.3rem', width: '100%', boxSizing: 'border-box' }}
              />
              <div style={{ maxHeight: '18rem', overflowY: 'auto', marginTop: '0.3rem', border: '1px solid var(--border)', borderRadius: '0.4rem', padding: '0.4rem' }}>
                {manualCandidates.length === 0 ? (
                  <p className="muted" style={{ fontSize: '0.85rem' }}>当前筛选下无词条</p>
                ) : (
                  manualCandidates.map((i) => (
                    <label
                      key={i.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.3rem 0.5rem',
                        borderRadius: '0.3rem',
                        cursor: 'pointer',
                        lineHeight: 1.4,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={draft.manualIds.includes(i.id)}
                        onChange={() => toggleManual(i.id)}
                        style={{ margin: 0, flexShrink: 0, width: '1rem', height: '1rem', cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: '0.9rem', fontWeight: 500, flex: 1 }}>{i.term}</span>
                      <span className="muted" style={{ fontSize: '0.8rem', flexShrink: 0 }}>{i.chinese || i.paper}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="row" style={{ marginTop: '0.8rem' }}>
            <button className="primary" onClick={submit}>{editingId ? '保存' : '生成'}</button>
            <button onClick={saveDraft}>暂存草稿</button>
            <button onClick={() => { setDraft(null); setEditingId(null); setError(''); }}>取消</button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {quizzes.length === 0 ? (
          <div className="empty-state" style={{ padding: '1rem' }}><p className="muted">还没有创建过测验/作业。</p></div>
        ) : (
          <table className="check-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>类型</th>
                <th>密码</th>
                <th>已提交</th>
                <th>题数</th>
                <th>题型</th>
                <th>限时</th>
                <th>开考时间</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {quizzes.map((q) => (
                <tr key={q.id}>
                  <td>{q.title}</td>
                  <td>{KIND_LABELS[q.kind]}</td>
                  <td className="term" style={{ fontWeight: 600 }}>{q.code}</td>
                  <td>{submissionCounts[q.id] ?? 0}</td>
                  <td>{q.question_count}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{q.question_types.map((t) => TYPE_LABELS[t as QuizQuestionType]).join('、')}</td>
                  <td>{formatDuration(q.duration_minutes)}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{q.open_at ? new Date(q.open_at).toLocaleString() : '随时'}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{new Date(q.created_at).toLocaleString()}</td>
                  <td>
                    <button onClick={() => viewSubmissions(q)}>成绩</button>
                    <button onClick={() => startEdit(q)}>编辑</button>
                    {confirmingDelete === q.id ? (
                      <>
                        <button className="danger" onClick={() => remove(q)}>确认删除</button>
                        <button onClick={() => setConfirmingDelete(null)}>取消</button>
                      </>
                    ) : (
                      <button className="danger" onClick={() => setConfirmingDelete(q.id)}>删除</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
