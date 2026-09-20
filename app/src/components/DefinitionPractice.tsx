// 定义题练习（Beta）：看术语 → 用自己的话写定义 → AI 按"必踩要素"判正确 / 部分正确 / 未答对
//
// 设计要点：
//   1. 题目来自 definition_items（主站 Supabase，登录可读），踩分点是"参考来源为中心"的必踩点；
//   2. 判分走 /app-api/ai/complete：模型只判逐要素覆盖度，档位由代码确定性算出（可复现）；
//   3. 结果写进掌握度与打卡（recordItem → 自动计入当日题数与错题本），作答日志落 definition_attempts；
//   4. 挂 Beta 入口，先在日常打卡训练里跑，一段时间检验合格后再进作业。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore, useStudySession, useCelebrateCheckIn } from '../lib/store';
import { loadDefinitionItems, saveDefinitionAttempt, type DefinitionItem } from '../lib/definition';
import { gradeDefinition, type GradeResult, type Verdict } from '../lib/ai';
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
  // 范围分类：与其它题型一致（考卷 / 单元）
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [units, setUnits] = useState<string[]>([]);

  // 计时：仅在作答/判分阶段计入学习时长（与其它练习一致）
  useStudySession(phase === 'answering' || phase === 'grading');
  useCelebrateCheckIn(phase === 'done');

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
    setPhase('answering');
  }, [scoped, vocabByTerm]);

  const cur = round[idx];
  const reqCount = cur ? cur.item.keypoints.filter((k) => k.kind !== 'example').length : 0;
  const exCount = cur ? cur.item.keypoints.filter((k) => k.kind === 'example').length : 0;

  const submit = useCallback(async () => {
    if (!cur || !answer.trim()) return;
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
      // 计分：correct = 1 题、partial = 0.5 题（计入正确率，掌握度不变、不进错题本）、wrong = 0 题
      if (cur.vocabId) {
        recordItem(cur.vocabId, res.verdict === 'correct', 'definition', { score: VERDICT_SCORE[res.verdict] });
      }
      void saveDefinitionAttempt({
        itemId: cur.item.id,
        answer: answer.trim(),
        verdict: res.verdict,
        coverage: res.coverage,
        listingOnly: res.listingOnly,
        reason: res.reason,
        model: res.model,
        tier: res.tier,
        ms: res.ms,
      });
      setPhase('graded');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setPhase('answering');
    }
  }, [cur, answer, recordItem]);

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
    setPhase('answering');
  }, [idx, round.length]);

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

          <div style={{ marginTop: '0.5rem' }}>
            <div className="muted" style={{ fontSize: '0.85rem' }}>必踩要素对照：</div>
            <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>
              {cur?.item.keypoints.map((k, i) => (
                <li key={i} style={{ marginBottom: '0.2rem' }}>
                  <span style={{ marginRight: '0.3rem' }}>{covMark(grade.coverage[i] ?? 0)}</span>
                  {k.kind === 'example' ? <span className="badge" style={{ marginRight: '0.3rem', fontSize: '0.72rem' }}>举例</span> : null}
                  {k.text}
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
                  <li key={i} className="muted" style={{ marginBottom: '0.2rem' }}>{b.text}</li>
                ))}
              </ul>
            </div>
          ) : null}

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
