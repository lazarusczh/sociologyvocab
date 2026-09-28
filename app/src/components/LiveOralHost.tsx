// 教师端 · 口头速答（oral）
//
// 与拼写竞赛完全分开的一套：**没有问题文本、没有判定、没有淘汰与积分**。
// 教师口头出题 → 学生打字提交（可反复修改）→ 这里实名列出所有答案 → 投屏窗口匿名展示。
//
// 实时性：订阅 rounds（开题/收题）与 answers（学生提交/修改）。
// answers 的 Realtime 推送受订阅者 RLS 过滤 —— 教师能收到全班的，学生只收到自己那一行。
import { useCallback, useEffect, useState } from 'react';
import {
  closeOralRound,
  fetchLatestOralRound,
  fetchOralAnswers,
  openOralRound,
  subscribeLive,
  type LiveOralAnswer,
  type LiveOralRound,
  type LiveSession,
} from '../lib/live';

interface Props {
  session: LiveSession;
  onExit: () => void;
}

export default function LiveOralHost({ session, onExit }: Props) {
  const [round, setRound] = useState<LiveOralRound | null>(null);
  const [answers, setAnswers] = useState<LiveOralAnswer[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    const r = await fetchLatestOralRound(session.id);
    setRound(r);
    setAnswers(r ? await fetchOralAnswers(r.id) : []);
  }, [session.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeLive(session.id, () => void refresh()), [session.id, refresh]);

  const nextRound = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await openOralRound(session.id, (round?.round_no ?? 0) + 1, note.trim() || undefined);
      setNote('');
      setRound(r);
      setAnswers([]);
      setMsg(`第 ${r.round_no} 题已开始，学生端可以作答了。`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finishRound = async () => {
    if (!round) return;
    setBusy(true);
    setMsg('');
    try {
      await closeOralRound(round.id);
      await refresh();
      setMsg('已收题：学生端不能再改，可以投屏讲评了。');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openBoard = () => {
    window.open(`${window.location.origin}/?board=${session.id}`, '_blank', 'noopener');
  };

  const open = round?.state === 'open';

  return (
    <>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>{session.title || '口头速答'}</strong>
          <span className="badge">口头速答</span>
          {round && <span className="badge">{open ? `第 ${round.round_no} 题 · 作答中` : `第 ${round.round_no} 题 · 已收题`}</span>}
          <span className="spacer" />
          <span className="muted" style={{ fontSize: '0.85rem' }}>已收到 {answers.length} 份回答</span>
          <button className="ghost" onClick={openBoard} disabled={!round}>打开投屏窗口</button>
          <button className="ghost" onClick={onExit} disabled={busy}>结束活动</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注（可选，只给你自己看，例如「涂尔干的概念」）"
            style={{ flex: 1, minWidth: 200 }}
          />
          <button className="primary" onClick={nextRound} disabled={busy || open}>
            {round ? '开下一题' : '开第一题'}
          </button>
          {open && (
            <button className="ghost" onClick={finishRound} disabled={busy}>收题</button>
          )}
        </div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 0 }}>
          问题由你口头说；学生端只有一个输入框，随时可以改答案。投屏窗口只显示答案文本、随机顺序、不带姓名。
        </p>
        {msg && <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.9rem' }}>{msg}</p>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>收到的回答（实名）</h3>
        {answers.length === 0 ? (
          <p className="muted">{round ? '还没有人提交。' : '先开一题。'}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {answers.map((a) => (
              <div
                key={a.id}
                className="row"
                style={{ gap: '0.5rem', alignItems: 'baseline', paddingBottom: '0.25rem', borderBottom: '1px solid var(--border, #e5e7eb)' }}
              >
                <span className="muted" style={{ fontSize: '0.8rem', minWidth: '6em' }}>{a.name || a.user_id.slice(0, 6)}</span>
                <span style={{ flex: 1 }}>{a.text}</span>
                <span className="muted" style={{ fontSize: '0.75rem' }}>{new Date(a.updated_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
