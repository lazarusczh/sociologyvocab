// 教师端：逐题揭晓（阶段 answered → reveal）
//
// 口径（见《模拟调研实装方案.md》第七节）：
//   · 每次只推进一步：先「公布答案」，再「公布内心」
//   · 内心只有教师读得到；投屏窗口负责展示，学生手机只显示「请看大屏」
//   · 内心默认折叠：控制台可能被投屏，别让它自己漏出来
import { useCallback, useEffect, useState } from 'react';
import {
  answerText,
  fetchInner,
  fetchAnswers,
  fetchPersonas,
  fetchReveals,
  personasFor,
  reveal,
  simErrorMessage,
  subscribeSim,
  type SimAnswerRow,
  type SimPaper,
  type SimPersona,
  type SimReveal,
} from '../lib/sim';

interface InnerRow {
  persona_id: string;
  inner_json: { qid: string; text: string }[];
  closing: string | null;
}

interface Props {
  sessionId: string;
  paper: SimPaper;
  pack: string;
  /** 本场参与答卷的人设 id；空数组 = 整包 */
  selectedIds: string[];
}

export default function SimRevealPanel({ sessionId, paper, pack, selectedIds }: Props) {
  const [personas, setPersonas] = useState<SimPersona[]>([]);
  const [answers, setAnswers] = useState<SimAnswerRow[]>([]);
  const [inner, setInner] = useState<InnerRow[]>([]);
  const [reveals, setReveals] = useState<SimReveal[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  // 只摊开本场勾选的人设：整包的其它卡不该出现在揭晓里（会显示成「未作答」）
  // 依赖用字符串 key 而不是数组，避免父组件每次重渲染（每 5 秒）都重拉一遍
  const selKey = selectedIds.join(',');

  const refresh = useCallback(async () => {
    const [ps, as, ins, rs] = await Promise.all([
      fetchPersonas(pack),
      fetchAnswers(sessionId, paper.version),
      fetchInner(sessionId, paper.version),
      fetchReveals(sessionId),
    ]);
    setPersonas(personasFor(ps, selKey ? selKey.split(',') : []));
    setAnswers(as);
    setInner(ins);
    setReveals(rs);
  }, [sessionId, paper.version, pack, selKey]);

  useEffect(() => {
    void refresh().catch((e: unknown) => setMsg(simErrorMessage(e)));
  }, [refresh]);

  useEffect(() => subscribeSim(sessionId, () => void refresh()), [sessionId, refresh]);

  const has = (qid: string, stage: 'answers' | 'inner') =>
    reveals.some((r) => r.qid === qid && r.stage === stage);

  const doReveal = async (qid: string, stage: 'answers' | 'inner') => {
    setBusy(`${qid}:${stage}`);
    setMsg('');
    try {
      await reveal(sessionId, qid, stage);
      await refresh();
    } catch (e) {
      setMsg(simErrorMessage(e));
    } finally {
      setBusy('');
    }
  };

  const openBoard = () => {
    window.open(`${window.location.origin}/?board=${sessionId}`, '_blank', 'noopener');
  };

  const answerOf = (personaId: string, qid: string): { text: string; skipped: boolean } => {
    const row = answers.find((a) => a.persona_id === personaId);
    const hit = row?.answers.find((a) => a.qid === qid);
    if (!hit) return { text: '（未作答）', skipped: false };
    if (hit.skipped) return { text: '（留空）', skipped: true };
    return { text: answerText(paper.items.find((x) => x.qid === qid)!, hit.value), skipped: false };
  };

  const innerOf = (personaId: string, qid: string): string => {
    const row = inner.find((x) => x.persona_id === personaId);
    return row?.inner_json.find((x) => x.qid === qid)?.text ?? '';
  };

  const closingOf = (personaId: string): string =>
    inner.find((x) => x.persona_id === personaId)?.closing ?? '';

  const answersDone = paper.items.filter((it) => has(it.qid, 'answers')).length;
  const innerDone = paper.items.filter((it) => has(it.qid, 'inner')).length;

  return (
    <>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>逐题揭晓</strong>
          <span className="badge">AI 模拟</span>
          <span className="badge">答案 {answersDone}/{paper.items.length}</span>
          <span className="badge">内心 {innerDone}/{paper.items.length}</span>
          <span className="spacer" />
          <button className="ghost" onClick={openBoard}>打开投屏窗口</button>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem', margin: '0.35rem 0 0' }}>
          先公布答案，再公布内心。学生手机只显示「请看大屏」，内心不会下发到学生端。
        </p>
        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '0.35rem 0 0' }}>{msg}</p>}
      </div>

      {paper.items.map((it, i) => {
        const aDone = has(it.qid, 'answers');
        const iDone = has(it.qid, 'inner');
        const showInner = preview === it.qid;
        return (
          <div key={it.qid} className="card" style={{ marginBottom: '0.8rem' }}>
            <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span className="badge">{i + 1}</span>
              {it.source_group ? <span className="badge">第 {it.source_group} 组</span> : null}
              {it.edited_by_teacher && <span className="badge">教师润色</span>}
              <span className="spacer" />
              <button className="ghost" onClick={() => setPreview(showInner ? null : it.qid)}>
                {showInner ? '收起预览' : '预览（含答案与内心）'}
              </button>
              <button className="primary" onClick={() => void doReveal(it.qid, 'answers')} disabled={aDone || !!busy}>
                {aDone ? '答案已公布' : '公布答案'}
              </button>
              <button
                className="primary"
                onClick={() => void doReveal(it.qid, 'inner')}
                disabled={!aDone || iDone || !!busy}
              >
                {iDone ? '内心已公布' : '公布内心'}
              </button>
            </div>

            <p style={{ margin: '0.45rem 0 0.35rem', lineHeight: 1.55 }}>{it.stem}</p>

            {/* 控制台常常被投屏：答案默认只在「已公布」或显式预览时才显示 */}
            {aDone || showInner ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {personas.map((p) => {
                  const a = answerOf(p.id, it.qid);
                  return (
                    <div key={p.id} className="row" style={{ gap: '0.5rem', alignItems: 'baseline' }}>
                      <span className="badge">{p.name}</span>
                      <span style={{ fontSize: '0.9rem' }}>{a.text}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted" style={{ fontSize: '0.82rem', margin: 0 }}>
                答案尚未公布（点「预览」可提前看）。
              </p>
            )}

            {showInner && (
              <div style={{ marginTop: '0.5rem', borderTop: '1px dashed var(--border)', paddingTop: '0.45rem' }}>
                {personas.map((p) => (
                  <div key={p.id} style={{ marginBottom: '0.3rem' }}>
                    <span className="badge">{p.name}</span>
                    <span className="muted" style={{ fontSize: '0.88rem', marginLeft: '0.4rem' }}>
                      {innerOf(p.id, it.qid) || '（这一题没有内心）'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {innerDone === paper.items.length ? (
        <div className="card">
          <strong style={{ fontSize: '0.95rem' }}>收尾（投屏已显示）</strong>
          {personas.map((p) => (
            <p key={p.id} style={{ margin: '0.35rem 0 0', fontSize: '0.88rem' }}>
              <span className="badge">{p.name}</span> {closingOf(p.id) || '（暂无）'}
            </p>
          ))}
        </div>
      ) : (
        <div className="card">
          <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
            收尾会在最后一题的内心公布后显示；现在还差 {paper.items.length - innerDone} 题的内心。
          </p>
        </div>
      )}
    </>
  );
}
