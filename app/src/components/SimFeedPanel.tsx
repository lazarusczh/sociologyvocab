// 教师端：把冻结问卷投给三张人设卡（阶段 frozen → answered）
//
// 口径（见《模拟调研人设卡.md》第四节）：
//   · 一次调用同时产出答案与内心；RPC 在同一事务里写两张表
//   · 任一份不合格就整份丢弃并重试，不允许"答案落了、内心没落"
//   · 逐人进度 + 单人重试；三人不齐不进揭晓（服务端也会卡住阶段）
//   · 顺序投喂，避免免费池并发 429
import { useCallback, useEffect, useRef, useState } from 'react';
import { callComplete } from '../lib/ai';
import {
  fetchAnswers,
  storePersonaResult,
  type SimPaper,
  type SimPersona,
} from '../lib/sim';
import { buildPersonaPrompt, parsePersonaResult } from '../lib/simPrompt';

type RunStatus = 'idle' | 'running' | 'ok' | 'err';
interface Run {
  status: RunStatus;
  msg?: string;
}

interface Props {
  sessionId: string;
  paper: SimPaper;
  personas: SimPersona[];
  onChanged: () => void;
}

export default function SimFeedPanel({ sessionId, paper, personas, onChanged }: Props) {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // 刷新页面 / 换设备后：已经写入的人要显示「已完成」，不能让人重投。
  // 只按 (session, version) 读一次：父组件每 5 秒会重拉一遍，不能把「生成中 / 失败」冲掉。
  const personasRef = useRef(personas);
  personasRef.current = personas;
  const loadedRef = useRef('');
  useEffect(() => {
    const key = `${sessionId}:${paper.version}`;
    if (loadedRef.current === key) return;
    loadedRef.current = key;
    void (async () => {
      try {
        const rows = await fetchAnswers(sessionId, paper.version);
        const next: Record<string, Run> = {};
        for (const p of personasRef.current) {
          const hit = rows.find((r) => r.persona_id === p.id);
          if (hit) next[p.id] = { status: 'ok', msg: `${hit.answers.length} 题` };
        }
        setRuns((prev) => ({ ...prev, ...next }));
      } catch (e) {
        setMsg((e as Error).message);
      }
    })();
  }, [sessionId, paper.version]);

  const runOne = useCallback(
    async (persona: SimPersona): Promise<boolean> => {
      setRuns((r) => ({ ...r, [persona.id]: { status: 'running' } }));
      let lastErr = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const text = await callComplete(buildPersonaPrompt(persona.card, paper.items, persona.name), {
            maxTokens: 1800,
            temperature: 0.8,
          });
          const { result, error } = parsePersonaResult(text.text, paper.items);
          if (!result) {
            lastErr = error ?? '格式异常';
            continue;
          }
          const written = await storePersonaResult({
            sessionId,
            version: paper.version,
            personaId: persona.id,
            answers: result.answers,
            inner: result.inner,
            closing: result.closing,
            raw: { model: text.model, tier: text.tier, text: text.text },
          });
          setRuns((r) => ({
            ...r,
            [persona.id]: { status: 'ok', msg: `${written.answers}/${written.needed} 人已完成` },
          }));
          onChanged();
          return true;
        } catch (e) {
          lastErr = (e as Error).message;
        }
      }
      setRuns((r) => ({ ...r, [persona.id]: { status: 'err', msg: lastErr || '失败' } }));
      return false;
    },
    [sessionId, paper, onChanged],
  );

  const runAll = async () => {
    setBusy(true);
    setMsg('');
    try {
      for (const p of personas) {
        if (runs[p.id]?.status === 'ok') continue;
        // 一个人失败不挡住后面的人：老师可以单独重试
        await runOne(p);
      }
    } finally {
      setBusy(false);
    }
  };

  if (personas.length === 0) {
    return (
      <div className="card">
        <p style={{ color: 'var(--danger)', marginTop: 0 }}>
          云端没有这个场景包的人设卡（pack）。请确认 sim_personas 里有对应 pack 的行。
        </p>
        <p className="muted" style={{ marginBottom: 0, fontSize: '0.85rem' }}>
          人设卡只有教师账号能读；学生端即使拿到链接也读不到。
        </p>
      </div>
    );
  }

  const doneCount = personas.filter((p) => runs[p.id]?.status === 'ok').length;

  return (
    <>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>投喂三位受访者（{doneCount}/{personas.length} 已完成）</strong>
          <span className="badge">AI 模拟</span>
          <span className="spacer" />
          <button className="primary" onClick={runAll} disabled={busy || doneCount >= personas.length}>
            {busy ? '生成中…' : doneCount === 0 ? '开始投喂' : '继续投喂'}
          </button>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem', margin: '0.35rem 0 0' }}>
          一次生成答案与内心；三人齐了才进入揭晓。同一份问卷有 {paper.items.length} 题（version {paper.version}）。
        </p>
        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '0.35rem 0 0' }}>{msg}</p>}
      </div>

      {personas.map((p) => {
        const run = runs[p.id] ?? { status: 'idle' as RunStatus };
        return (
          <div key={p.id} className="card" style={{ marginBottom: '0.8rem' }}>
            <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <strong>{p.name}</strong>
              <span className={`badge ${run.status === 'ok' ? 'success' : run.status === 'err' ? 'danger' : ''}`}>
                {run.status === 'idle'
                  ? '未开始'
                  : run.status === 'running'
                    ? '生成中…'
                    : run.status === 'ok'
                      ? '已完成'
                      : '失败'}
              </span>
              <span className="spacer" />
              <button
                className="ghost"
                onClick={() => void runOne(p)}
                disabled={busy || run.status === 'running'}
              >
                {run.status === 'ok' ? '重投' : '单人重试'}
              </button>
            </div>
            {run.status === 'err' && (
              <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '0.4rem 0 0', whiteSpace: 'pre-wrap' }}>
                {run.msg}
              </p>
            )}
            {run.status === 'ok' && run.msg && (
              <p className="muted" style={{ fontSize: '0.82rem', margin: '0.35rem 0 0' }}>{run.msg}</p>
            )}
          </div>
        );
      })}
    </>
  );
}
