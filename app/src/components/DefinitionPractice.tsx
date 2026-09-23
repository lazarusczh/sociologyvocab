// 定义题练习（Beta）：看术语 → 用自己的话写定义 → AI 按"必踩要素"判正确 / 部分正确 / 未答对
//
// 设计要点：
//   1. 题目来自 definition_items（主站 Supabase，登录可读），踩分点是"参考来源为中心"的必踩点；
//   2. 判分走 /app-api/ai/complete：模型只判逐要素覆盖度，档位由代码确定性算出（可复现）；
//   3. 结果写进掌握度与打卡（recordItem → 自动计入当日题数与错题本），作答日志落 definition_attempts；
//   4. 挂 Beta 入口，先在日常打卡训练里跑，一段时间检验合格后再进作业。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore, useStudySession, useCelebrateCheckIn, useElapsedTimer } from '../lib/store';
import { loadDefinitionItems, saveDefinitionAttempt, submitDefinitionDispute, type DefinitionItem } from '../lib/definition';
import { gradeDefinition, SOURCE_LABEL, type GradeResult, type Verdict } from '../lib/ai';
import { normalizeKey } from '../lib/answers';
import { sample } from '../lib/shuffle';
import { PAPER_ORDER } from '../lib/storage';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';
import type { VocabItem } from '../lib/types';

const ROUND = 5;                 // 一轮 5 题（写定义为输出型任务，不宜过长）
const MAX_ANSWER = 600;

interface RoundItem {
  item: DefinitionItem;
  vocabId: string | null;        // 关联词库条目 id（用于掌握度 / 错题本）
}

type Phase = 'idle' | 'loading' | 'answering' | 'grading' | 'graded' | 'done';

const VERDICT_META: Record<Verdict, { label: string; cls: string; icon: string }> = {
  correct: { label: '正确', cls: 'badge success', icon: '✓' },
  partial: { label: '部分正确', cls: 'badge warn', icon: '◐' },
  wrong: { label: '未答对', cls: 'badge danger', icon: '✗' },
};

// 计分口径：正确 1 题、部分正确 0.5 题、未答对 0 题（半对不进错题本，掌握度也不变）
const VERDICT_SCORE: Record<Verdict, number> = { correct: 1, partial: 0.5, wrong: 0 };

const covMark = (v: number) => (v >= 0.99 ? '✓' : v >= 0.4 ? '◐' : '✗');

export default function DefinitionPractice() {
  const { vocab, recordItem, authUser } = useStore();
  const [pool, setPool] = useState<DefinitionItem[] | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [round, setRound] = useState<RoundItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const [stats, setStats] = useState<Record<Verdict, number>>({ correct: 0, partial: 0, wrong: 0 });
  const [showHint, setShowHint] = useState(false);
  // 本次作答的日志 id：用于「我认为判错了」的质疑（没有它无法关联到具体这次判分）
  const [attemptId, setAttemptId] = useState<number | null>(null);
  // 质疑：说明 + 提交状态（提交成功后不再显示按钮，避免重复提交）
  const [disputeNote, setDisputeNote] = useState('');
  const [disputeState, setDisputeState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [disputeErr, setDisputeErr] = useState('');
  // 范围分类：与其它题型一致（考卷 / 单元）
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [units, setUnits] = useState<string[]>([]);

  // 计时：仅在作答/判分阶段计入学习时长（与其它练习一致）
  // ⚠️ XP-C 待办（2026-09-22，《XP-C档改造方案.md》§8 新口径）：elapsed_ms 要求**只覆盖 answering**
  //    （判分等待是服务端响应时间，不算学生投入）。但**不能现在就把 `grading` 摘掉** ——
  //    打卡目前仍是**本地权威**，摘掉会立刻减少学生的打卡时长、拉低达标率，且与「打卡切服务端」
  //    不同步。**必须与「打卡服务端化」同批上线时再拆**，不可提前。
  useStudySession(phase === 'answering' || phase === 'grading');
  useCelebrateCheckIn(phase === 'done');

  // 本题用时计时器（随 XP 事件上报为 elapsed_ms）。
  // ⚠ 只用 peek/reset、**不用 lap** —— 定义题的用时必须在「点击提交」那一刻取
  //   （判分等待是服务端响应时间，不算学生投入），但此刻**不能重置**：
  //   万一判分失败学生要重答，那段重答时间得继续累加（约定：累计本题所有 answering 段，
  //   判分失败是系统问题、不该让学生损失时长）。只有上报真的成功了才 reset。
  const timer = useElapsedTimer();

  const load = useCallback(async () => {
    setLoadErr('');
    setPhase('loading');
    try {
      const items = await loadDefinitionItems();
      setPool(items);
      setPhase('idle');
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 术语 → 词库条目（用于把作答计入掌握度/错题本）
  const vocabByTerm = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of vocab) m.set(normalizeKey(v.term), v.id);
    return m;
  }, [vocab]);

  // 范围分类：把题目映射成 CategoryFilter 需要的形状（它只用到 paper / category / unit 字段），
  // 再用同一个 filterByPaperCat 过滤，保证与其它题型的筛选口径完全一致。
  const asVocab = useMemo<VocabItem[]>(
    () => (pool ?? []).map((d) => ({
      id: d.id, type: 'term' as const, term: d.term, chinese: d.chinese ?? '',
      definition: '', paper: d.paper ?? '', category: '', unit: d.units ?? [],
    })),
    [pool],
  );
  const paperOptions = useMemo(() => PAPER_ORDER.filter((p) => asVocab.some((v) => v.paper === p)), [asVocab]);
  const scopedIds = useMemo(
    () => new Set(filterByPaperCat(asVocab, paper, cat, units).map((v) => v.id)),
    [asVocab, paper, cat, units],
  );
  const scoped = useMemo(() => (pool ?? []).filter((d) => scopedIds.has(d.id)), [pool, scopedIds]);

  const start = useCallback(() => {
    if (!scoped.length) return;
    const picked: RoundItem[] = sample(scoped, Math.min(ROUND, scoped.length)).map((item) => ({
      item,
      vocabId: vocabByTerm.get(normalizeKey(item.term)) ?? null,
    }));
    setRound(picked);
    setIdx(0);
    setAnswer('');
    setGrade(null);
    setErrMsg('');
    setShowHint(false);
    setStats({ correct: 0, partial: 0, wrong: 0 });
    timer.reset(); // 新的一轮：计时从第一题呈现时算起
    setPhase('answering');
  }, [scoped, vocabByTerm, timer]);

  const cur = round[idx];
  const reqCount = cur ? cur.item.keypoints.filter((k) => k.kind !== 'example').length : 0;
  const exCount = cur ? cur.item.keypoints.filter((k) => k.kind === 'example').length : 0;
  // 判分参照的各来源英文原文（展示用，不要求复述）
  const refDefs = useMemo(
    () => Object.entries(cur?.item.source_defs ?? {}).filter(([, d]) => d && d.trim()),
    [cur],
  );

  const submit = useCallback(async () => {
    if (!cur || !answer.trim()) return;
    // 本题用时：**必须在进入 grading 之前取**，判分等待是服务端响应时间、不算学生投入。
    // 此处只 peek 不 reset：万一判分失败学生要重答，那段重答时间得继续累加。
    const elapsedMs = timer.peek();
    setPhase('grading');
    setErrMsg('');
    try {
      const res = await gradeDefinition(
        cur.item.term,
        cur.item.keypoints,
        answer.trim(),
        cur.item.source_defs ?? {},
      );
      setGrade(res);
      setStats((s) => ({ ...s, [res.verdict]: s[res.verdict] + 1 }));
      // 计分：correct = 1 题、partial = 0.5 题（计入正确率、掌握度不变、不进错题本）、wrong = 0 题。
      // elapsed_ms 是**每题一次**（与本题的 recordItem 一一对应），不是整轮，
      // 取自上面「题目呈现 → 点击提交」那段 answering 用时。
      if (cur.vocabId) {
        recordItem(cur.vocabId, res.verdict === 'correct', 'definition', {
          score: VERDICT_SCORE[res.verdict],
          elapsedMs,
        });
      }
      timer.reset(); // 已上报 ⇒ 本题计时归零（判分失败走不到这里，故重答时间得以保留）
      // 作答日志：拿到 id 才能支持「我认为判错了」的质疑；restate 一并存档（教师复核时能看到模型的理解）
      void saveDefinitionAttempt({
        itemId: cur.item.id,
        answer: answer.trim(),
        verdict: res.verdict,
        coverage: res.coverage,
        listingOnly: res.listingOnly,
        reason: res.reason,
        restate: res.restate,
        model: res.model,
        tier: res.tier,
        ms: res.ms,
      }).then((id) => { if (id) setAttemptId(id); });
      setPhase('graded');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      // 判分失败：**故意不 reset 计时器** —— 学生重答的时间继续累计到本题，
      // 下次提交时一并上报（判分失败是系统问题，不该让学生损失时长）。
      setPhase('answering');
    }
  }, [cur, answer, recordItem, timer]);

  const next = useCallback(() => {
    if (idx + 1 >= round.length) {
      setPhase('done');
      return;
    }
    setIdx((i) => i + 1);
    setAnswer('');
    setGrade(null);
    setErrMsg('');
    setShowHint(false);
    setAttemptId(null);
    setDisputeNote('');
    setDisputeState('idle');
    setDisputeErr('');
    timer.reset(); // 切到下一题：重新开始计本题用时
    setPhase('answering');
  }, [idx, round.length, timer]);

  // 提交质疑：写进该次作答记录（后台复核面板会优先显示被质疑的）
  const sendDispute = useCallback(async () => {
    if (!attemptId) {
      setDisputeErr('作答记录尚未保存，请稍后再试。');
      return;
    }
    setDisputeState('sending');
    setDisputeErr('');
    const err = await submitDefinitionDispute(attemptId, disputeNote);
    if (err) {
      setDisputeState('idle');
      setDisputeErr(err);
      return;
    }
    setDisputeState('sent');
  }, [attemptId, disputeNote]);

  // ---------- 渲染 ----------

  if (!authUser) {
    return (
      <div className="card">
        <h2>定义题练习 (Beta)</h2>
        <p className="muted">需要登录后使用：判分由服务端 AI 完成，未登录无法调用。</p>
      </div>
    );
  }

  if (phase === 'loading') {
    return <div className="card"><p className="muted">正在载入题目…</p></div>;
  }

  if (loadErr) {
    return (
      <div className="card">
        <h2>定义题练习 (Beta)</h2>
        <p className="muted">题目载入失败：{loadErr}</p>
        <button className="primary" onClick={() => void load()} style={{ marginTop: '0.6rem' }}>重试</button>
      </div>
    );
  }

  if (phase === 'idle' || phase === 'done') {
    const total = stats.correct + stats.partial + stats.wrong;
    return (
      <div>
        {phase === 'done' && (
          <div className="card" style={{ marginBottom: '0.8rem' }}>
            <h2>本轮完成</h2>
            <div className="row" style={{ gap: '0.8rem', margin: '0.4rem 0' }}>
              <span className="badge success">正确 {stats.correct}</span>
              <span className="badge warn">部分正确 {stats.partial}</span>
              <span className="badge danger">未答对 {stats.wrong}</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              共 {total} 题。已计入今日打卡与掌握度（只有"正确"计为答对）。
            </p>
          </div>
        )}
        {asVocab.length > 0 && (
          <CategoryFilter
            items={asVocab}
            papers={paperOptions}
            categories={[]}
            paper={paper}
            onPaperChange={(p) => { setPaper(p); setCat('all'); setUnits([]); }}
            cat={cat}
            onCatChange={(c) => { setCat(c); setUnits([]); }}
            units={units}
            onUnitsChange={setUnits}
          />
        )}

        <div className="card">
          <div className="row" style={{ alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>定义题练习</h2>
            <span className="badge warn" style={{ marginLeft: '0.5rem' }}>Beta</span>
          </div>
          <p className="muted">
            看术语，用你自己的话写定义。AI 会按「必踩要素」判定：<strong>正确 / 部分正确 / 未答对</strong>。
            中英文作答都可以，意思到了就算覆盖。
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            当前范围 <strong>{scoped.length}</strong> 个术语（共 {pool?.length ?? 0} 个）· 每轮
            {' '}{Math.min(ROUND, scoped.length || ROUND)} 题 · 判分走 nemotron 免费档（不消耗魔搭额度）
          </p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            计分：正确 1 题、部分正确 0.5 题、未答对 0 题（都计入打卡题数与时长；只有"未答对"进错题本）
          </p>
          <button className="primary" onClick={start} disabled={!scoped.length} style={{ marginTop: '0.4rem' }}>
            {phase === 'done' ? '再来一轮' : '开始练习'}
          </button>
        </div>
      </div>
    );
  }

  // answering / grading / graded
  const meta = grade ? VERDICT_META[grade.verdict] : null;

  return (
    <div>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <span className="muted">第 {idx + 1} / {round.length} 题</span>
          <span className="spacer" />
          <span className="badge success">✓ {stats.correct}</span>
          <span className="badge warn" style={{ marginLeft: '0.3rem' }}>◐ {stats.partial}</span>
        </div>
      </div>

      <div className="card">
        <div className="muted" style={{ fontSize: '0.85rem' }}>请写出下面术语的定义</div>
        <h2 style={{ margin: '0.2rem 0 0.4rem' }}>{cur?.item.term}</h2>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem' }}>
          {showHint
            ? <span className="muted">{cur?.item.chinese || '（无中文提示）'}</span>
            : <button className="ghost" onClick={() => setShowHint(true)} style={{ fontSize: '0.85rem' }}>看中文提示</button>}
          <span className="spacer" />
          {cur?.item.units?.length ? <span className="badge">{cur.item.units[0]}</span> : null}
        </div>

        {cur && (reqCount > 0 || exCount > 0) ? (
          <p className="muted" style={{ fontSize: '0.82rem', margin: '0.4rem 0 0' }}>
            💡 判分口径：
            {reqCount > 0 ? `${reqCount} 个主干要点必须答到` : ''}
            {reqCount > 0 && exCount > 0 ? '；' : ''}
            {exCount > 0 ? `另有 ${exCount} 项并列举例，举出其中 ${exCount <= 2 ? 1 : 2} 项即可` : ''}
          </p>
        ) : null}

        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value.slice(0, MAX_ANSWER))}
          disabled={phase !== 'answering'}
          placeholder="用中文或英文写下你的定义…"
          rows={5}
          style={{ width: '100%', marginTop: '0.6rem', resize: 'vertical' }}
        />

        {errMsg && (
          <p style={{ color: 'var(--c-critical-ink, #c00)', fontSize: '0.9rem', margin: '0.4rem 0 0' }}>
            判分失败：{errMsg}
          </p>
        )}

        {phase !== 'graded' && (
          <div className="row" style={{ marginTop: '0.6rem' }}>
            <button className="primary" onClick={() => void submit()} disabled={!answer.trim() || phase === 'grading'}>
              {phase === 'grading' ? 'AI 判分中…' : '提交'}
            </button>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: '0.8rem' }}>{answer.length}/{MAX_ANSWER}</span>
          </div>
        )}
      </div>

      {phase === 'graded' && grade && meta && (
        <div className="card" style={{ marginTop: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className={meta.cls} style={{ fontSize: '1rem' }}>{meta.icon} {meta.label}</span>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              {grade.tier} · {(grade.ms / 1000).toFixed(1)}s
            </span>
          </div>
          {grade.reason && <p className="muted" style={{ margin: '0.5rem 0 0.2rem' }}>{grade.reason}</p>}

          {/* 模型的「理解」：它把这段答案读成了什么意思。
              判错时这一行最关键 —— 它能区分「学生确实没说」与「模型理解错了」，两者要的处理完全不同。 */}
          {grade.restate?.length ? (
            <div className="muted" style={{ fontSize: '0.85rem', margin: '0.35rem 0 0' }}>
              <span style={{ opacity: 0.75 }}>模型理解为：</span>
              {grade.restate.map((s, i) => (
                <span key={i}>{i > 0 ? '；' : ''}「{s}」</span>
              ))}
            </div>
          ) : null}

          <div style={{ marginTop: '0.5rem' }}>
            <div className="muted" style={{ fontSize: '0.85rem' }}>必踩要素对照：</div>
            <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>
              {cur?.item.keypoints.map((k, i) => (
                <li key={i} style={{ marginBottom: '0.2rem' }}>
                  <span style={{ marginRight: '0.3rem' }}>{covMark(grade.coverage[i] ?? 0)}</span>
                  {k.kind === 'example' ? <span className="badge" style={{ marginRight: '0.3rem', fontSize: '0.72rem' }}>举例</span> : null}
                  {k.text}
                  {k.en ? <span className="muted" style={{ fontSize: '0.78rem' }}> · {k.en}</span> : null}
                </li>
              ))}
            </ul>
          </div>

          {cur?.item.bonus?.length ? (
            <div style={{ marginTop: '0.5rem' }}>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                加分要素（其它来源独有，不要求必答）：
              </div>
              <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>
                {cur.item.bonus.slice(0, 4).map((b, i) => (
                  <li key={i} className="muted" style={{ marginBottom: '0.2rem' }}>
                    {b.text}
                    {b.en ? <span style={{ fontSize: '0.78rem' }}> · {b.en}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {refDefs.length ? (
            <div style={{ marginTop: '0.5rem' }}>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                各来源原文（判分参照，不要求复述）：
              </div>
              <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>
                {refDefs.map(([src, d]) => (
                  <li key={src} className="muted" style={{ marginBottom: '0.2rem', fontSize: '0.82rem' }}>
                    <span className="badge" style={{ marginRight: '0.3rem', fontSize: '0.72rem' }}>
                      {SOURCE_LABEL[src] ?? src}
                    </span>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 提交质疑：判分由模型完成，可能判错。学生提出后会在教师后台的「定义题复核」里优先显示 */}
          {disputeState === 'sent' ? (
            <p className="muted" style={{ margin: '0.7rem 0 0', fontSize: '0.85rem' }}>
              ✓ 已收到你的质疑，老师会在复核时看到。
            </p>
          ) : (
            <div style={{ marginTop: '0.7rem', borderTop: '1px solid var(--c-hairline)', paddingTop: '0.6rem' }}>
              <div className="muted" style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>
                觉得判得不对？可以说明理由，老师会在后台复核。
              </div>
              <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  placeholder="例如：这是同义表达 / 这条要素我其实答到了"
                  value={disputeNote}
                  onChange={(e) => setDisputeNote(e.target.value)}
                  maxLength={500}
                  style={{ flex: 1, minWidth: '14rem' }}
                />
                <button
                  className="ghost"
                  disabled={disputeState === 'sending' || !attemptId}
                  onClick={() => void sendDispute()}
                >
                  {disputeState === 'sending' ? '提交中…' : '我认为判错了'}
                </button>
              </div>
              {disputeErr && (
                <p className="muted" style={{ color: 'var(--c-warn, #b45309)', fontSize: '0.82rem', margin: '0.3rem 0 0' }}>
                  {disputeErr}
                </p>
              )}
            </div>
          )}

          <div className="row" style={{ marginTop: '0.7rem' }}>
            <button className="primary" onClick={next}>
              {idx + 1 >= round.length ? '完成本轮' : '下一题'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
