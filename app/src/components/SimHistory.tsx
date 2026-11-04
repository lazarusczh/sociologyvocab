// 课后回看：模拟调研的问卷、三位受访者的答案与内心（教师端）
//
// 口径：
//   · 人设卡与内心都是 teacher-only（RLS）；学生端不展示访谈记录，只看到「由老师保存」
//   · 「AI 模拟」标识必须留在每一屏：这些答案不是真实调查数据，别被当成证据引用
import { useCallback, useEffect, useState } from 'react';
import {
  answerText,
  fetchAnswers,
  fetchInner,
  fetchLatestPaper,
  fetchPersonas,
  fetchSimSession,
  simErrorMessage,
  type SimAnswerRow,
  type SimPaper,
  type SimPersona,
} from '../lib/sim';

interface InnerRow {
  persona_id: string;
  inner_json: { qid: string; text: string }[];
  closing: string | null;
}

export default function SimHistory({ sessionId, isTeacher }: { sessionId: string; isTeacher: boolean }) {
  const [paper, setPaper] = useState<SimPaper | null>(null);
  const [personas, setPersonas] = useState<SimPersona[]>([]);
  const [answers, setAnswers] = useState<SimAnswerRow[]>([]);
  const [inner, setInner] = useState<InnerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const s = await fetchSimSession(sessionId);
    const p = await fetchLatestPaper(sessionId);
    setPaper(p);
    if (!p) return;
    const ps = await fetchPersonas(s?.config?.pack ?? 'unpaid_labour');
    setPersonas(ps);
    setAnswers(await fetchAnswers(sessionId, p.version));
    setInner(await fetchInner(sessionId, p.version));
  }, [sessionId]);

  useEffect(() => {
    if (!isTeacher) {
      setLoading(false);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        await load();
      } catch (e) {
        if (alive) setMsg(simErrorMessage(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [load, isTeacher]);

  if (loading) return <div className="card"><p className="muted" style={{ margin: 0 }}>正在读取模拟调研记录…</p></div>;

  if (!isTeacher) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          模拟调研不计分。问卷与三位受访者的访谈记录由老师保存，学生端不展示。
        </p>
      </div>
    );
  }

  if (!paper) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>这场没有定稿的问卷（可能中途结束了）。</p>
        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: '0.4rem 0 0' }}>{msg}</p>}
      </div>
    );
  }

  const answerOf = (personaId: string, qid: string): string => {
    const row = answers.find((a) => a.persona_id === personaId);
    const hit = row?.answers.find((a) => a.qid === qid);
    if (!hit) return '（未作答）';
    if (hit.skipped) return '（留空）';
    const item = paper.items.find((x) => x.qid === qid);
    return item ? answerText(item, hit.value) : String(hit.value);
  };

  const innerOf = (personaId: string, qid: string): string =>
    inner.find((x) => x.persona_id === personaId)?.inner_json.find((x) => x.qid === qid)?.text ?? '';

  return (
    <>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>模拟调研记录</strong>
          <span className="badge">AI 模拟</span>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            问卷 version {paper.version} · {paper.items.length} 题 · {personas.length} 位受访者
          </span>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem', margin: '0.35rem 0 0' }}>
          答案与内心由 AI 按人设卡生成，不是真实调查数据。内心与收尾只有教师端可见。
        </p>
        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '0.35rem 0 0' }}>{msg}</p>}
      </div>

      {paper.items.map((it, i) => (
        <div key={it.qid} className="card" style={{ marginBottom: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span className="badge">{i + 1}</span>
            {it.source_group ? <span className="badge">第 {it.source_group} 组</span> : null}
            {it.edited_by_teacher && <span className="badge">教师润色</span>}
          </div>
          <p style={{ margin: '0.45rem 0 0.35rem', lineHeight: 1.55 }}>{it.stem}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {personas.map((p) => {
              const txt = innerOf(p.id, it.qid);
              return (
                <div key={p.id} style={{ fontSize: '0.9rem' }}>
                  <span className="badge">{p.name}</span>
                  <strong style={{ marginLeft: '0.4rem' }}>{answerOf(p.id, it.qid)}</strong>
                  {txt && <span className="muted" style={{ marginLeft: '0.5rem' }}>心里：{txt}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="card">
        <strong style={{ fontSize: '0.95rem' }}>收尾</strong>
        {personas.map((p) => (
          <p key={p.id} style={{ margin: '0.35rem 0 0', fontSize: '0.88rem' }}>
            <span className="badge">{p.name}</span>{' '}
            {inner.find((x) => x.persona_id === p.id)?.closing || '（暂无）'}
          </p>
        ))}
      </div>
    </>
  );
}
