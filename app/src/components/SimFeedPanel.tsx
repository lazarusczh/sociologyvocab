// 教师端：让勾选的人设卡按冻结问卷作答（阶段 frozen → answered）
//
// 口径（见《模拟调研人设卡.md》第四节）：
//   · 一次调用同时产出答案与内心；RPC 在同一事务里写两张表
//   · 任一份不合格就整份丢弃并重试，不允许"答案落了、内心没落"
//   · 逐人进度 + 单人重试；勾选的都答完才进揭晓（服务端也会卡住阶段）
//   · 一个人一个人生成，避免免费池并发 429
//   · 整包往往有十几张卡，但不是每场都要用完：教师在这里勾选参与本场的人设，
//     选择落在 live_sessions.config.personaIds（服务端按它算「齐了没有」）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callComplete } from '../lib/ai';
import {
  fetchAnswers,
  personasFor,
  setSessionPersonas,
  simErrorMessage,
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
  /** 整包人设卡（只有教师读得到） */
  personas: SimPersona[];
  /** 本场参与答卷的人设 id；空数组 = 整包 */
  selectedIds: string[];
  onChanged: () => void;
}

export default function SimFeedPanel({ sessionId, paper, personas, selectedIds, onChanged }: Props) {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  // 勾选的人设；勾选记录失效时退回整包（与服务端兜底一致）
  const picked = useMemo(() => personasFor(personas, selectedIds), [personas, selectedIds]);
  const pickedIds = useMemo(() => picked.map((p) => p.id), [picked]);
  const pickedSet = useMemo(() => new Set(pickedIds), [pickedIds]);

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
            [persona.id]: { status: 'ok', msg: `已记录（进度 ${written.answers}/${written.needed}）` },
          }));
          onChanged();
          return true;
        } catch (e) {
          lastErr = simErrorMessage(e);
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
      for (const p of picked) {
        if (runs[p.id]?.status === 'ok') continue;
        // 一个人失败不挡住后面的人：老师可以单独重试
        await runOne(p);
      }
    } finally {
      setBusy(false);
    }
  };

  // 勾选/取消一位：写云端后由父组件重拉（不在本地留一份，避免两处真相）
  const toggle = async (id: string) => {
    const cur = new Set(pickedIds);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    if (cur.size === 0) {
      setMsg('至少要保留一位受访者');
      return;
    }
    const ids = personas.filter((p) => cur.has(p.id)).map((p) => p.id);
    setSaving(true);
    setMsg('');
    try {
      await setSessionPersonas(sessionId, ids);
      onChanged();
    } catch (e) {
      setMsg(simErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const selectAll = async () => {
    setSaving(true);
    setMsg('');
    try {
      await setSessionPersonas(sessionId, personas.map((p) => p.id));
      onChanged();
    } catch (e) {
      setMsg(simErrorMessage(e));
    } finally {
      setSaving(false);
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

  const doneCount = picked.filter((p) => runs[p.id]?.status === 'ok').length;
  const allPicked = picked.length === personas.length;

  return (
    <>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>参与答卷的受访者（{picked.length}/{personas.length}）</strong>
          <span className="spacer" />
          <button className="ghost" onClick={() => void selectAll()} disabled={busy || saving || allPicked}>
            {allPicked ? '已全选' : '全选'}
          </button>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem', margin: '0.35rem 0 0.5rem' }}>
          不是每场都要用完整个包：只勾选本场要用的几位，生成与「答完」判定都按勾选算。
          勾选的都答完就进入揭晓，之后不能再改。
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {personas.map((p) => {
            const on = pickedSet.has(p.id);
            const st = runs[p.id]?.status;
            return (
              <label
                key={p.id}
                className="row"
                style={{ alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', cursor: busy || saving ? 'default' : 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => void toggle(p.id)}
                  disabled={busy || saving}
                />
                <span>{p.name}</span>
                {!on && <span className="muted" style={{ fontSize: '0.8rem' }}>本场不参与</span>}
                {on && st === 'ok' && <span className="badge success">已完成</span>}
                {on && st === 'running' && <span className="badge">生成中…</span>}
                {on && st === 'err' && <span className="badge danger">失败</span>}
              </label>
            );
          })}
        </div>
        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '0.4rem 0 0' }}>{msg}</p>}
      </div>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>受访者的回答（{doneCount}/{picked.length} 已生成）</strong>
          <span className="badge">AI 模拟</span>
          <span className="spacer" />
          <button className="primary" onClick={runAll} disabled={busy || saving || doneCount >= picked.length}>
            {busy ? '生成中…' : doneCount === 0 ? '开始生成' : '继续生成'}
          </button>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem', margin: '0.35rem 0 0' }}>
          一次生成答案与内心；勾选的受访者齐了才进入揭晓。同一份问卷有 {paper.items.length} 题（version {paper.version}）。
        </p>
      </div>

      {picked.map((p) => {
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
                disabled={busy || saving || run.status === 'running'}
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
