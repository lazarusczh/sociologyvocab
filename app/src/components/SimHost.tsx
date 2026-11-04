// 教师端：模拟调研控制台（S1：创建 → 点名 → 分组 → 组内编辑总览）
//
// 口径（见《模拟调研实装方案.md》第四节、第六节）：
//   · 学生随到随进，分组由教师点「开始分组」时一次性随机轮转发牌（人数差 ≤1）
//   · 无人提交题目时才允许重新分组（服务端也会拒绝，这里只提前说明）
//   · 阶段与人数全部来自云端；实时只是变更信号，收到就重拉
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { fetchRunningSession, type LiveSession } from '../lib/live';
import {
  assignGroups,
  closeSimSession,
  createSimSession,
  fetchGroups,
  fetchLatestPaper,
  fetchParticipants,
  fetchPersonas,
  fetchQuestions,
  fetchRunningSimSession,
  fetchSimSession,
  groupLimitOf,
  phaseOf,
  simErrorMessage,
  subscribeSim,
  targetSizeOf,
  type SimGroup,
  type SimPaper,
  type SimParticipant,
  type SimPersona,
  type SimQuestion,
  type SimSession,
} from '../lib/sim';
import SimMergePanel from './SimMergePanel';
import SimFeedPanel from './SimFeedPanel';
import SimRevealPanel from './SimRevealPanel';

const PHASE_LABEL: Record<string, string> = {
  lobby: '点名中',
  grouped: '组内写问卷',
  frozen: '问卷已定稿',
  answered: '访谈已完成',
  reveal: '逐题揭晓',
};

const clampInt = (v: string, min: number, max: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || v.trim() === '') return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export default function SimHost() {
  const { authUser } = useStore();
  const uid = authUser?.id ?? '';

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SimSession | null>(null);
  const [otherRunning, setOtherRunning] = useState<LiveSession | null>(null);
  const [participants, setParticipants] = useState<SimParticipant[]>([]);
  const [groups, setGroups] = useState<SimGroup[]>([]);
  const [questions, setQuestions] = useState<SimQuestion[]>([]);
  const [paper, setPaper] = useState<SimPaper | null>(null);
  const [personas, setPersonas] = useState<SimPersona[]>([]);

  const [title, setTitle] = useState('模拟调研');
  const [targetSize, setTargetSize] = useState('5');
  const [perGroup, setPerGroup] = useState('3');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 秒针：把「最后一位加入于 N 秒前」变成会动的判据
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(async (sid: string) => {
    const s = await fetchSimSession(sid);
    setSession(s);
    const ps = await fetchParticipants(sid);
    setParticipants(ps);
    const ph = s ? phaseOf(s) : 'lobby';
    if (ph === 'lobby') {
      setGroups([]);
      setQuestions([]);
      setPaper(null);
      setPersonas([]);
      return;
    }
    const [gs, qs] = await Promise.all([fetchGroups(sid), fetchQuestions(sid)]);
    setGroups(gs);
    setQuestions(qs);
    if (ph === 'grouped') {
      setPaper(null);
      setPersonas([]);
      return;
    }
    // 冻结之后：问卷快照 + 这个包的人设卡（卡只有教师读得到）
    const p = await fetchLatestPaper(sid);
    setPaper(p);
    setPersonas(p ? await fetchPersonas(s?.config?.pack ?? 'unpaid_labour') : []);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetchRunningSimSession();
        if (!alive) return;
        setSession(s);
        if (s) await refresh(s.id);
        else {
          // 同一时间只允许一场进行中的课堂活动：拼写 / 口头速答在跑时先提示
          const other = await fetchRunningSession();
          if (alive) setOtherRunning(other && other.kind !== 'sim' ? other : null);
        }
      } catch (e) {
        if (alive) setMsg((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // 实时信号 + 5 秒兜底轮询（点名屏要看见陆续进来的人）
  useEffect(() => {
    if (!session) return;
    return subscribeSim(session.id, () => void refresh(session.id));
  }, [session, refresh]);

  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => void refresh(session.id), 5000);
    return () => window.clearInterval(id);
  }, [session, refresh]);

  const handleCreate = async () => {
    if (!uid) return;
    setBusy(true);
    setMsg('');
    try {
      const s = await createSimSession(uid, title.trim() || '模拟调研', {
        targetGroupSize: clampInt(targetSize, 2, 10, 5),
        perGroupLimit: clampInt(perGroup, 1, 10, 3),
      });
      setSession(s);
      setGroups([]);
      setQuestions([]);
      setParticipants([]);
    } catch (e) {
      setMsg(simErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleAssign = async () => {
    if (!session) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await assignGroups(session.id);
      await refresh(session.id);
      setMsg(`已分成 ${r.groups} 组（${r.joined} 人），学生端会自动看到自己的组号与队友。`);
    } catch (e) {
      setMsg(simErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleClose = async () => {
    if (!session) return;
    setBusy(true);
    setMsg('');
    try {
      await closeSimSession(session.id);
      setSession(null);
      setParticipants([]);
      setGroups([]);
      setQuestions([]);
      setMsg('活动已结束。');
    } catch (e) {
      setMsg(simErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const lastJoin = useMemo(() => {
    if (participants.length === 0) return null;
    const t = participants.reduce((m, p) => Math.max(m, new Date(p.joined_at).getTime()), 0);
    return Math.round((Date.now() - t) / 1000);
  }, [participants]);

  if (loading) return <div className="card"><p className="muted">正在查找模拟调研…</p></div>;

  if (!session) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>模拟调研</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          学生分组写一份封闭式问卷，再请三位「受访者」作答，最后先公布答案、后公布内心。
        </p>

        {otherRunning && (
          <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>
            现在有一场「{otherRunning.title || otherRunning.kind}」正在进行。同一时间只允许一场课堂活动，
            请先结束它，否则学生端会先进到那一场。
          </p>
        )}

        {/* 三格用 grid 而不是 .row：.row 是 inline 流 + align-items:center，
            标签文字与输入框会各自换行，三列高低对不齐（2026-11-04 教师反馈） */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
            gap: '0.9rem',
            alignItems: 'end',
            marginBottom: '0.7rem',
          }}
        >
          <label style={{ display: 'block', minWidth: 0 }}>
            <span className="muted" style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem' }}>活动名称</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={30}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </label>
          <label style={{ display: 'block', minWidth: 0 }}>
            <span className="muted" style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem' }}>每组目标人数</span>
            <input
              type="number"
              min={2}
              max={10}
              value={targetSize}
              onChange={(e) => setTargetSize(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </label>
          <label style={{ display: 'block', minWidth: 0 }}>
            <span className="muted" style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem' }}>每组题数上限</span>
            <input
              type="number"
              min={1}
              max={10}
              value={perGroup}
              onChange={(e) => setPerGroup(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </label>
        </div>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
          组数不预先填：点「开始分组」时按当时实际人数算，每组不超过目标人数，各组人数差 ≤ 1。
        </p>

        <button
          className="primary"
          onClick={handleCreate}
          disabled={busy || !uid || !!otherRunning}
        >
          {busy ? '创建中…' : '开始模拟调研'}
        </button>
        {!uid && <p className="muted" style={{ fontSize: '0.85rem' }}>请先登录教师账号。</p>}
        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
      </div>
    );
  }

  // 活动已被结束（可能是在另一台设备上点的）
  if (session.state !== 'running') {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{session.title || '模拟调研'}</h2>
        <p className="muted">这场活动已经结束。</p>
        <button className="primary" onClick={() => { setSession(null); setParticipants([]); setGroups([]); setQuestions([]); }}>
          回到创建
        </button>
      </div>
    );
  }

  const phase = phaseOf(session);
  const target = targetSizeOf(session);
  const limit = groupLimitOf(session);
  const totalQuestions = questions.length;

  const header = (
    <div className="card" style={{ marginBottom: '0.8rem' }}>
      <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong>{session.title || '模拟调研'}</strong>
        <span className="badge">{PHASE_LABEL[phase] ?? phase}</span>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          已加入 {participants.length} 人 · 目标每组 {target} 人 · 每组最多 {limit} 题
        </span>
        <span className="spacer" />
        <button className="ghost" onClick={handleClose} disabled={busy}>结束活动</button>
      </div>
      {phase === 'lobby' && (
        <p className="muted" style={{ fontSize: '0.85rem', margin: '0.4rem 0 0' }}>
          {lastJoin === null
            ? '还没有人加入 —— 让学生打开「课堂活动」并点加入。'
            : `最后一位加入于 ${lastJoin} 秒前（这个数字在动 = 还有人在进）。`}
        </p>
      )}
    </div>
  );

  if (phase === 'lobby') {
    return (
      <>
        {header}
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong>点到名单（{participants.length} 人）</strong>
            <span className="spacer" />
            <button
              className="primary"
              onClick={handleAssign}
              disabled={busy || participants.length === 0}
            >
              {busy ? '分组中…' : '开始分组'}
            </button>
          </div>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            人少也能点：会按此刻在场的人分组。分组后学生端自动显示组号与队友。
          </p>
          {participants.length === 0 ? (
            <p className="muted">还没有人加入。</p>
          ) : (
            <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
              {participants.map((p) => (
                <span key={p.id} className="badge">{p.name || '未命名同学'}</span>
              ))}
            </div>
          )}
          {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
        </div>
      </>
    );
  }

  if (phase === 'grouped') {
    return (
      <>
        {header}
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <strong>分组（{groups.length} 组 · 共 {totalQuestions} 题）</strong>
            <span className="spacer" />
            <button
              className="ghost"
              onClick={handleAssign}
              disabled={busy || totalQuestions > 0}
              title={totalQuestions > 0 ? '已经有学生写了题，不能再重新分组' : '按当前人数重分'}
            >
              重新分组
            </button>
          </div>
          {totalQuestions > 0 && (
            <p className="muted" style={{ fontSize: '0.82rem' }}>
              已有学生提交题目，重新分组会打乱作者与题目的归属，所以已禁用。
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.45rem' }}>
            {groups.map((g) => {
              const members = participants.filter((p) => p.group_id === g.id);
              const n = questions.filter((q) => q.group_id === g.id).length;
              return (
                <div key={g.id} className="row" style={{ alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span className="badge">第 {g.group_no} 组</span>
                  <span className="muted" style={{ fontSize: '0.85rem' }}>{members.length} 人 · {n}/{limit} 题</span>
                  <span className="muted" style={{ fontSize: '0.82rem' }}>
                    {members.map((p) => p.name || '未命名同学').join('、') || '暂无成员'}
                  </span>
                </div>
              );
            })}
          </div>
          {msg && <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>{msg}</p>}
        </div>

        <SimMergePanel
          sessionId={session.id}
          groups={groups}
          participants={participants}
          questions={questions}
          limit={limit}
          onFrozen={(v) => {
            setMsg(`问卷已定稿（version ${v}），接下来由三位受访者作答。`);
            void refresh(session.id);
          }}
        />
      </>
    );
  }

  if (phase === 'frozen') {
    return (
      <>
        {header}
        {paper ? (
          <SimFeedPanel
            sessionId={session.id}
            paper={paper}
            personas={personas}
            onChanged={() => void refresh(session.id)}
          />
        ) : (
          <div className="card"><p className="muted" style={{ margin: 0 }}>正在载入已定稿的问卷…</p></div>
        )}
      </>
    );
  }

  // answered / reveal
  return (
    <>
      {header}
      {paper ? (
        <SimRevealPanel sessionId={session.id} paper={paper} pack={session.config?.pack ?? 'unpaid_labour'} />
      ) : (
        <div className="card"><p className="muted" style={{ margin: 0 }}>正在载入问卷…</p></div>
      )}
    </>
  );
}
