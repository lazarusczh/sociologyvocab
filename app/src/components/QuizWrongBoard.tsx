// 跨卷全局错题榜（教师端）：按词条 itemId 跨所有测验/作业聚合「已交卷」学生的作答，
// 统计答错次数/错率，可按题型与单元切片，展开查看具体答错学生及其作答 vs 正确答案。
// 数据口径：仅 status = submitted；排除 developer/测试账号（识别与成绩列表一致）。
// 说明：流派（theory/theories）切片暂缓，待教师标注完成后接入。
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import type { Quiz, QuizSubmission, QuizQuestionType, QuizKind } from '../lib/types';
import { collectWrongAttempts, TYPE_LABELS, KIND_LABELS } from '../lib/quiz';
import type { WrongAttempt } from '../lib/quiz';
import { listQuizzes, listSubmissionsByQuizzes, listDeveloperIds } from '../lib/cloud';
import { maskEmail } from '../lib/shuffle';

type TypeFilter = 'all' | QuizQuestionType;

interface BoardRow {
  itemId: string;
  term: string;          // 展示名：优先当前词库，其次题目快照
  chinese: string;
  itemType: 'term' | 'scholar';
  paper: string;
  units: string[];
  attempts: number;      // 跨卷总作答次数（已交卷）
  wrong: number;         // 答错次数
  cases: WrongAttempt[]; // 答错明细（下钻）
}

export default function QuizWrongBoard({ onBack }: { onBack: () => void }) {
  const { vocab } = useStore();
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [subs, setSubs] = useState<QuizSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [unitFilter, setUnitFilter] = useState('all');
  const [sortMode, setSortMode] = useState<'wrong' | 'rate'>('wrong');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = await listQuizzes();
      setQuizzes(qs);
      if (qs.length === 0) {
        setSubs([]);
        return;
      }
      const devIds = new Set(await listDeveloperIds());
      const all = await listSubmissionsByQuizzes(qs.map((q) => q.id));
      // 排除 developer/测试账号；其余由聚合函数按 submitted 口径处理
      setSubs(all.filter((s) => !devIds.has(s.user_id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 词条级作答明细（已交卷、已排除测试账号）
  const attempts = useMemo(() => collectWrongAttempts(quizzes, subs), [quizzes, subs]);

  const vocabById = useMemo(() => new Map(vocab.map((i) => [i.id, i])), [vocab]);
  const attemptedItemIds = useMemo(() => new Set(attempts.map((a) => a.itemId)), [attempts]);

  // 单元切片选项：只列「出现过作答的词条」所属单元（保持词库中的自然顺序）
  const unitOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: string[] = [];
    for (const it of vocab) {
      if (!attemptedItemIds.has(it.id)) continue;
      for (const u of it.unit ?? []) {
        if (!seen.has(u)) {
          seen.add(u);
          opts.push(u);
        }
      }
    }
    return opts;
  }, [vocab, attemptedItemIds]);

  const rows = useMemo<BoardRow[]>(() => {
    const map = new Map<string, BoardRow>();
    const add = (a: WrongAttempt) => {
      const it = vocabById.get(a.itemId);
      let r = map.get(a.itemId);
      if (!r) {
        r = {
          itemId: a.itemId,
          term: it?.term || a.term,
          chinese: it?.chinese || a.chinese || '',
          itemType: it?.type || a.itemType,
          paper: it?.paper || '',
          units: it?.unit ?? [],
          attempts: 0,
          wrong: 0,
          cases: [],
        };
        map.set(a.itemId, r);
      }
      r.attempts++;
      if (!a.correct) {
        r.wrong++;
        r.cases.push(a);
      }
    };
    for (const a of attempts) {
      if (typeFilter !== 'all' && a.qtype !== typeFilter) continue;
      if (unitFilter !== 'all' && !(vocabById.get(a.itemId)?.unit ?? []).includes(unitFilter)) continue;
      add(a);
    }
    const arr = [...map.values()].filter((r) => r.wrong > 0); // 错题榜：仅列有答错记录的词条
    arr.sort((x, y) => {
      const rate = (r: BoardRow) => (r.attempts > 0 ? r.wrong / r.attempts : 0);
      const byWrong = y.wrong - x.wrong;
      const byRate = rate(y) - rate(x);
      const byTerm = x.term.localeCompare(y.term);
      if (sortMode === 'rate') return byRate || byWrong || byTerm;
      return byWrong || byRate || byTerm;
    });
    return arr;
  }, [attempts, typeFilter, unitFilter, sortMode, vocabById]);

  // 顶部统计口径（无论切片，反映排除测试账号后的全量数据）
  const stats = useMemo(() => {
    const students = new Set<string>();
    const quizIds = new Set<string>();
    let wrong = 0;
    for (const a of attempts) {
      students.add(a.userId);
      quizIds.add(a.quizId);
      if (!a.correct) wrong++;
    }
    return { students: students.size, quizzes: quizIds.size, total: attempts.length, wrong };
  }, [attempts]);

  const showEmpty = !loading && quizzes.length === 0;
  const showNoData = !loading && quizzes.length > 0 && stats.total === 0;
  const showNoWrong = !loading && stats.total > 0 && rows.length === 0;

  return (
    <div>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem' }}>
          <button className="ghost" onClick={onBack}>← 返回</button>
          <h3 style={{ margin: 0 }}>跨卷错题榜（全局）</h3>
          <span className="spacer" />
          <button className="ghost" onClick={load} disabled={loading}>{loading ? '加载中…' : '刷新'}</button>
        </div>
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          按词条跨卷聚合所有测验/作业中「已交卷」学生的作答，供课后讲解与选题参考。错率 = 答错次数 ÷ 作答次数；
          已排除开发/测试账号，与成绩列表口径一致。可展开词条查看具体答错学生与作答对比。
        </p>
        {!loading && stats.total > 0 && (
          <div style={{ marginTop: '0.4rem', display: 'flex', flexWrap: 'wrap', gap: '1rem', fontSize: '0.9rem' }}>
            <span>涉及试卷 <strong>{stats.quizzes}</strong> 份</span>
            <span>学生 <strong>{stats.students}</strong> 人</span>
            <span>作答 <strong>{stats.total}</strong> 次</span>
            <span>其中答错 <strong style={{ color: 'var(--danger, #c62828)' }}>{stats.wrong}</strong> 次</span>
          </div>
        )}
        {error && (
          <div className="card" style={{ marginTop: '0.6rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
            {error}
          </div>
        )}
      </div>

      {!showEmpty && !showNoData && (
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>题型：</span>
            <div className="tag-filter">
              <button className={typeFilter === 'all' ? 'active' : ''} onClick={() => setTypeFilter('all')}>全部</button>
              {(['spelling', 'choice', 'matching'] as QuizQuestionType[]).map((t) => (
                <button key={t} className={typeFilter === t ? 'active' : ''} onClick={() => setTypeFilter(t)}>
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
          {unitOptions.length > 0 && (
            <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.4rem' }}>
              <span className="muted" style={{ fontSize: '0.85rem' }}>单元：</span>
              <div className="tag-filter">
                <button className={unitFilter === 'all' ? 'active' : ''} onClick={() => setUnitFilter('all')}>全部单元</button>
                {unitOptions.map((u) => (
                  <button key={u} className={unitFilter === u ? 'active' : ''} onClick={() => setUnitFilter(u)}>{u}</button>
                ))}
              </div>
            </div>
          )}
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.4rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>排序：</span>
            <div className="tag-filter">
              <button className={sortMode === 'wrong' ? 'active' : ''} onClick={() => setSortMode('wrong')}>按错次数</button>
              <button className={sortMode === 'rate' ? 'active' : ''} onClick={() => setSortMode('rate')}>按错率</button>
            </div>
            <span className="muted" style={{ fontSize: '0.8rem' }}>（仅列出有答错记录的词条）</span>
          </div>
        </div>
      )}

      {showEmpty ? (
        <div className="card"><div className="empty-state"><p className="muted">还没有创建过测验/作业。</p></div></div>
      ) : showNoData ? (
        <div className="card"><div className="empty-state"><p className="muted">暂无已交卷记录。</p></div></div>
      ) : showNoWrong ? (
        <div className="card"><div className="empty-state"><p className="muted">当前切片范围内没有答错记录，继续保持！</p></div></div>
      ) : loading ? (
        <div className="card"><p className="muted" style={{ padding: '0.5rem 0' }}>加载中…</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="check-table">
            <thead>
              <tr>
                <th>#</th>
                <th>词条</th>
                <th>中文</th>
                <th>类型</th>
                <th>考卷</th>
                <th>单元</th>
                <th>作答次数</th>
                <th>答错</th>
                <th>错率</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const open = expandedId === r.itemId;
                return (
                  <Fragment key={r.itemId}>
                    <tr>
                      <td className="muted">{i + 1}</td>
                      <td style={{ fontWeight: 600 }}>{r.term}</td>
                      <td className="muted">{r.chinese || '—'}</td>
                      <td>
                        <span className={`badge ${r.itemType === 'term' ? 'success' : 'warn'}`}>
                          {r.itemType === 'term' ? '术语' : '学者'}
                        </span>
                      </td>
                      <td className="muted">{r.paper || '—'}</td>
                      <td className="muted" style={{ fontSize: '0.8rem' }}>{r.units.join('、') || '—'}</td>
                      <td>{r.attempts}</td>
                      <td>
                        <strong style={{ color: 'var(--danger, #c62828)' }}>{r.wrong}</strong>
                      </td>
                      <td>{Math.round((r.wrong / r.attempts) * 100)}%</td>
                      <td>
                        <button onClick={() => setExpandedId(open ? null : r.itemId)}>
                          {open ? '收起' : '展开'}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={10} style={{ background: 'var(--surface-alt, rgba(0,0,0,0.02))' }}>
                          <GroupedWrongCases cases={r.cases} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// 词条下钻：按试卷分组展示每个答错学生的作答 vs 正确答案（邮箱沿用脱敏规则）
function GroupedWrongCases({ cases }: { cases: WrongAttempt[] }) {
  const groups: { quizId: string; quizTitle: string; quizKind: QuizKind; cases: WrongAttempt[] }[] = [];
  for (const c of cases) {
    let g = groups.find((x) => x.quizId === c.quizId);
    if (!g) {
      g = { quizId: c.quizId, quizTitle: c.quizTitle, quizKind: c.quizKind, cases: [] };
      groups.push(g);
    }
    g.cases.push(c);
  }
  return (
    <div style={{ fontSize: '0.88rem' }}>
      {groups.map((g) => (
        <div key={g.quizId} style={{ padding: '0.4rem 0', borderTop: '1px solid var(--border)', marginTop: '0.2rem' }}>
          <span style={{ fontWeight: 600 }}>
            {g.quizTitle}
            <span className="muted" style={{ fontWeight: 400 }}>（{KIND_LABELS[g.quizKind]}）</span>
          </span>
          <span className="muted" style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}>
            答错 {g.cases.length} 人
          </span>
          <div style={{ marginTop: '0.3rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {g.cases.map((c, ci) => (
              <div key={ci}>
                <span style={{ fontWeight: 500 }}>
                  {c.name || (c.email ? maskEmail(c.email) : '未署名')}
                </span>
                <span className="muted" style={{ fontSize: '0.85rem' }}>
                  {' '}· {TYPE_LABELS[c.qtype]}{c.qtype === 'matching' ? '配对' : ''}
                  {c.submittedAt ? ` · ${new Date(c.submittedAt).toLocaleDateString()}` : ''}
                </span>
                <span style={{ fontSize: '0.85rem', marginLeft: '0.6rem' }}>
                  学生作答：<span style={{ color: 'var(--danger, #c62828)' }}>{c.studentAnswer}</span>
                  <span className="muted">；正确答案：</span>
                  <span style={{ color: 'var(--success, #2e7d32)' }}>{c.correctAnswer}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
