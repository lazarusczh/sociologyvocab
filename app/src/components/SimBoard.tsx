// 模拟调研投屏（`?board=<sessionId>`，教师窗口）
//
// 口径：先答案、后内心；焦点是**最近一次揭晓的那一题**。
// 内心只在这块屏幕上出现（教师 JWT 才有读权限），学生手机什么都不拿。
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  answerText,
  fetchAnswers,
  fetchInner,
  fetchLatestPaper,
  fetchPersonas,
  fetchReveals,
  fetchSimSession,
  phaseOf,
  subscribeSim,
  type SimAnswerRow,
  type SimPaper,
  type SimPersona,
  type SimReveal,
  type SimSession,
} from '../lib/sim';

interface InnerRow {
  persona_id: string;
  inner_json: { qid: string; text: string }[];
  closing: string | null;
}

export default function SimBoard({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SimSession | null>(null);
  const [paper, setPaper] = useState<SimPaper | null>(null);
  const [personas, setPersonas] = useState<SimPersona[]>([]);
  const [answers, setAnswers] = useState<SimAnswerRow[]>([]);
  const [inner, setInner] = useState<InnerRow[]>([]);
  const [reveals, setReveals] = useState<SimReveal[]>([]);

  const refresh = useCallback(async () => {
    const s = await fetchSimSession(sessionId);
    setSession(s);
    const pack = s?.config?.pack ?? 'unpaid_labour';
    const p = await fetchLatestPaper(sessionId);
    setPaper(p);
    setPersonas(await fetchPersonas(pack));
    if (p) {
      const [as, ins, rs] = await Promise.all([
        fetchAnswers(sessionId, p.version),
        fetchInner(sessionId, p.version),
        fetchReveals(sessionId),
      ]);
      setAnswers(as);
      setInner(ins);
      setReveals(rs);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => subscribeSim(sessionId, () => void refresh()), [sessionId, refresh]);

  const focus = useMemo(() => {
    if (!reveals.length) return null;
    return reveals.reduce((a, b) => (new Date(a.revealed_at) >= new Date(b.revealed_at) ? a : b));
  }, [reveals]);

  const big = { padding: '2rem', minHeight: '100vh', boxSizing: 'border-box' } as const;
  const muted = { color: 'var(--c-muted, #6b7280)' } as const;

  if (!session) {
    return <div style={big}><p style={{ fontSize: '1.4rem', ...muted }}>正在载入投屏数据…</p></div>;
  }

  const phase = phaseOf(session);
  const item = focus && paper ? paper.items.find((x) => x.qid === focus.qid) ?? null : null;
  const innerStage = focus ? reveals.some((r) => r.qid === focus.qid && r.stage === 'inner') : false;
  const allInner = paper ? paper.items.every((x) => reveals.some((r) => r.qid === x.qid && r.stage === 'inner')) : false;

  if (!paper || !item) {
    return (
      <div style={big}>
        <h1 style={{ fontSize: '2.2rem', margin: '0 0 0.6rem' }}>{session.title || '模拟调研'}</h1>
        <p style={{ fontSize: '1.1rem', margin: '0 0 1.2rem' }}>
          <span className="badge">AI 模拟</span> 回答由 AI 按人设卡生成，不是真实调查数据
        </p>
        <p style={{ fontSize: '2rem', ...muted }}>
          {phase === 'answered' ? '三位受访者已作答，等老师逐题揭晓…' : '等待老师公布答案…'}
        </p>
      </div>
    );
  }

  const idx = paper.items.findIndex((x) => x.qid === item.qid);

  return (
    <div style={big}>
      <h1 style={{ fontSize: '2rem', margin: '0 0 0.3rem' }}>{session.title || '模拟调研'}</h1>
      <p style={{ fontSize: '1rem', margin: '0 0 0.7rem' }}>
        <span className="badge">AI 模拟</span> 回答与内心由 AI 按人设卡生成，不是真实调查数据
      </p>
      <p style={{ fontSize: '1.3rem', margin: '0 0 1.2rem', ...muted }}>
        第 {idx + 1} / {paper.items.length} 题{item.source_group ? ` · 这题来自第 ${item.source_group} 组` : ''}
      </p>

      <p style={{ fontSize: '2.1rem', lineHeight: 1.45, margin: '0 0 1.2rem' }}>{item.stem}</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem', marginBottom: '1.6rem' }}>
        {personas.map((p) => {
          const row = answers.find((a) => a.persona_id === p.id);
          const hit = row?.answers.find((a) => a.qid === item.qid);
          const text = !hit ? '未作答' : hit.skipped ? '（留空）' : answerText(item, hit.value);
          return (
            <div key={p.id} className="card" style={{ margin: 0, padding: '0.9rem 1.3rem' }}>
              <span style={{ fontSize: '1.7rem', fontWeight: 600 }}>{p.name}</span>
              <span style={{ fontSize: '1.7rem', marginLeft: '0.8rem' }}>{text}</span>
            </div>
          );
        })}
      </div>

      {innerStage && (
        <div style={{ borderTop: '2px solid var(--border)', paddingTop: '1.2rem' }}>
          <p style={{ fontSize: '1.4rem', margin: '0 0 0.9rem', ...muted }}>他们心里想的</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {personas.map((p) => {
              const row = inner.find((x) => x.persona_id === p.id);
              const text = row?.inner_json.find((x) => x.qid === item.qid)?.text;
              if (!text) return null;
              return (
                <p key={p.id} style={{ fontSize: '1.6rem', lineHeight: 1.5, margin: 0 }}>
                  <strong>{p.name}</strong>：{text}
                </p>
              );
            })}
          </div>
        </div>
      )}

      {innerStage && (allInner || idx === paper.items.length - 1) && (
        <div style={{ borderTop: '2px solid var(--border)', marginTop: '1.4rem', paddingTop: '1.2rem' }}>
          <p style={{ fontSize: '1.4rem', margin: '0 0 0.9rem', ...muted }}>最后一句</p>
          {personas.map((p) => {
            const closing = inner.find((x) => x.persona_id === p.id)?.closing;
            if (!closing) return null;
            return (
              <p key={p.id} style={{ fontSize: '1.5rem', lineHeight: 1.5, margin: '0 0 0.5rem' }}>
                <strong>{p.name}</strong>：{closing}
              </p>
            );
          })}
        </div>
      )}

      <p style={{ marginTop: '2.2rem', fontSize: '1rem', ...muted }}>
        投屏视图 · 答案 {reveals.filter((r) => r.stage === 'answers').length}/{paper.items.length} 题已公布
      </p>
    </div>
  );
}
