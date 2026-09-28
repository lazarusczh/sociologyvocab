// 学生端 · 口头速答（oral）
//
// 只有一个输入框：问题由老师口头说，学生打字作答，**随时可以改**（一题一人只留最新一条）。
// 没有对错判定，所以这里不做任何"对不对"的反馈；看不到别人的回答（RLS 只放本人 + 教师）。
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import {
  fetchLatestOralRound,
  fetchMyOralAnswer,
  subscribeLive,
  upsertOralAnswer,
  type LiveOralRound,
  type LiveSession,
} from '../lib/live';

interface Props {
  session: LiveSession;
}

export default function LiveOralStudent({ session }: Props) {
  const { authUser } = useStore();
  const uid = authUser?.id ?? '';
  const myName = authUser?.name ?? null;

  const [round, setRound] = useState<LiveOralRound | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    const r = await fetchLatestOralRound(session.id);
    setRound(r);
    if (r) {
      const mine = await fetchMyOralAnswer(r.id, uid);
      setSaved(mine?.text ?? null);
      // 不覆盖正在输入的内容：只有本地为空或与已存一致时才跟随最新
      setText((prev) => (prev === '' || prev === saved ? (mine?.text ?? '') : prev));
    }
  }, [session.id, uid, saved]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeLive(session.id, () => void refresh()), [session.id, refresh]);

  const submit = async () => {
    if (!round) return;
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setMsg('');
    try {
      await upsertOralAnswer({
        roundId: round.id,
        sessionId: session.id,
        roundNo: round.round_no,
        userId: uid,
        name: myName,
        text: t,
      });
      setSaved(t);
      setMsg('已提交（随时可以再改）。');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!round) {
    return (
      <div className="card">
        <p>已加入，等待老师出第一题…</p>
        <p className="muted" style={{ fontSize: '0.9rem' }}>问题由老师口头说，这里会把输入框亮出来。</p>
      </div>
    );
  }

  const open = round.state === 'open';
  const changed = (saved ?? '') !== text.trim();

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center' }}>
        <span className="badge">{open ? `第 ${round.round_no} 题 · 作答中` : `第 ${round.round_no} 题 · 已收题`}</span>
        <span className="spacer" />
        {saved !== null && <span className="muted" style={{ fontSize: '0.85rem' }}>已提交</span>}
      </div>

      <p className="muted" style={{ fontSize: '0.9rem', margin: '0.5rem 0' }}>
        听老师的口头提问，把答案打在这里（可以随时修改，改完再点提交）。
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入你的回答…"
        rows={3}
        disabled={!open || busy}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />

      <div className="row" style={{ marginTop: '0.5rem', gap: '0.5rem', alignItems: 'center' }}>
        <button className="primary" onClick={submit} disabled={!open || busy || !text.trim() || !changed}>
          {changed ? '提交' : '已是最新'}
        </button>
        {!open && <span className="muted">老师已收题，不能再修改了。</span>}
        {msg && <span className="muted" style={{ fontSize: '0.9rem' }}>{msg}</span>}
      </div>
    </div>
  );
}
