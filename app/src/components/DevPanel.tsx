import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { supabase } from '../lib/supabase';
import { isCorrectAnswer, getAcceptableForms } from '../lib/answers';
import type { VocabItem } from '../lib/types';

// 开发后台：仅 developer 账号可见，用于指定词条测试答案判定（无需靠随机刷题）
export default function DevPanel() {
  const { vocab } = useStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<VocabItem | null>(null);
  const [testInput, setTestInput] = useState('');
  // AI 问答「学生视角」模拟：写入 localStorage（与知识库子站同源共享），
  // 子站提问时实时读取该 key，把教师/开发者的门禁判定按学生身份处理。
  const [simulateStudent, setSimulateStudent] = useState(
    () => (typeof localStorage !== 'undefined' ? localStorage.getItem('ask_simulate') === '1' : false),
  );
  const toggleSimulateStudent = () => {
    const v = !simulateStudent;
    setSimulateStudent(v);
    try {
      localStorage.setItem('ask_simulate', v ? '1' : '0');
    } catch { /* ignore */ }
  };

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return vocab
      .filter((i) => i.term.toLowerCase().includes(q) || i.chinese.toLowerCase().includes(q))
      .slice(0, 50);
  }, [vocab, query]);

  const testResult = selected && testInput.trim() ? isCorrectAnswer(selected, testInput) : null;

  // ===== Realtime 连通性自检（诊断用）=====
  // 三项独立判定，因为它们在当前托管实例上的可用性并不一致（实测：连接 ✓ / Presence ✓ / Broadcast ✗）：
  //   conn      能否订阅上频道（socket + join）
  //   presence  在线状态：track 之后能否收到 sync
  //   broadcast 发一条广播能否自己收回来（self:true）
  // 若 broadcast 失败且伴随 socket 断开，多半是服务端 realtime.messages 表「RLS 开着但没有策略」
  // （默认全拒，写入即内部错误 1011）。到控制台 Realtime Policies 建好策略后回来重测即可。
  type ProbeVerdict = 'idle' | 'running' | 'ok' | 'fail';
  const [probe, setProbe] = useState<{ conn: ProbeVerdict; presence: ProbeVerdict; broadcast: ProbeVerdict }>({
    conn: 'idle',
    presence: 'idle',
    broadcast: 'idle',
  });
  const [probeLog, setProbeLog] = useState<string[]>([]);

  const runRealtimeProbe = () => {
    setProbe({ conn: 'running', presence: 'running', broadcast: 'running' });
    setProbeLog([]);
    const t0 = performance.now();
    const log = (s: string) =>
      setProbeLog((l) => [...l, `+${String(Math.round(performance.now() - t0)).padStart(5)}ms  ${s}`]);
    // 只把仍处于 running 的项落定，避免覆盖已判定的结果
    const settle = (k: 'conn' | 'presence' | 'broadcast', v: 'ok' | 'fail') =>
      setProbe((p) => (p[k] === 'running' ? { ...p, [k]: v } : p));

    const ch = supabase.channel('realtime-probe', { config: { broadcast: { self: true } } });
    const timers: number[] = [];
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      timers.forEach((t) => clearTimeout(t));
      settle('conn', 'fail');
      settle('presence', 'fail');
      settle('broadcast', 'fail');
      void supabase.removeChannel(ch);
    };
    const later = (ms: number, fn: () => void) => { timers.push(window.setTimeout(fn, ms)); };

    ch.on('presence', { event: 'sync' }, () => {
      settle('presence', 'ok');
      log('Presence ✓ 收到 sync');
    });
    ch.on('broadcast', { event: 'ping' }, () => {
      settle('broadcast', 'ok');
      log('Broadcast ✓ 收到自己的广播回环');
      stop();
    });

    ch.subscribe((status) => {
      const s = String(status);
      log(`订阅状态：${s}`);
      if (s === 'SUBSCRIBED') {
        settle('conn', 'ok');
        ch.track({ probe: 1, at: Date.now() });
        log('已 track（测 Presence）');
        // 2 秒后若还没收到 presence sync，判 Presence 不可用，接着测 Broadcast
        later(2000, () => {
          settle('presence', 'fail');
          ch.send({ type: 'broadcast', event: 'ping', payload: { t: Date.now() } });
          log('已发送广播（测 Broadcast）');
        });
        later(4500, () => { settle('broadcast', 'fail'); log('广播 2.5 秒内未回环'); });
        later(5000, stop);
        return;
      }
      if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
        log(`服务端断开：${s}`);
        stop();
      }
    });

    later(12000, stop); // 总兜底
  };

  return (
    <div>
      <h1>开发后台</h1>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        仅 developer 账号可见。指定词条查看可接受写法，并直接测试某输入是否判对。
      </p>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="gate-switch-row">
          <label className="switch" title="学生视角模拟">
            <input
              type="checkbox"
              checked={simulateStudent}
              onChange={toggleSimulateStudent}
            />
            <span className="switch__track"><span className="switch__thumb" /></span>
          </label>
          <div className="gate-switch-meta">
            <div className="gate-switch-title">学生视角模拟</div>
            <div className="row tight">
              <span className={simulateStudent ? 'badge warn' : 'badge'}>
                {simulateStudent ? '模拟中' : '关闭'}
              </span>
              <span className="muted gate-switch-sub">
                {simulateStudent ? '子站按学生身份判定门禁' : '你享有教师 / 开发者豁免'}
              </span>
            </div>
          </div>
        </div>
        <p className="muted" style={{ margin: '0', fontSize: '0.8rem' }}>
          开启后，知识库子站（/skill/）的 AI 问答会按「学生身份」判定——例如教师已关闭 AI 门禁时，你会像学生一样被拦截提示；教师 / 开发者的豁免不再生效。无需注册纯学生账号；勾选状态保存在本机。
        </p>
      </div>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <input
          type="text"
          placeholder="搜索术语名 / 中文…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() && (
          <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {results.length === 0 && <p className="muted">无匹配词条</p>}
            {results.map((i) => (
              <button
                key={i.id}
                className={selected?.id === i.id ? 'active' : ''}
                onClick={() => { setSelected(i); setTestInput(''); }}
              >
                {i.term}{i.chinese ? `（${i.chinese}）` : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="card">
          <h3>
            {selected.term}{' '}
            {selected.chinese && <span className="muted" style={{ fontSize: '0.9rem' }}>（{selected.chinese}）</span>}
          </h3>
          <p className="muted" style={{ fontSize: '0.85rem' }}>{selected.definition}</p>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            {selected.paper}
            {selected.category ? ` / ${selected.category}` : ''}
            {selected.unit?.length ? ` / ${selected.unit.join('、')}` : ''}
          </p>

          <div style={{ marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>
              可接受写法（{getAcceptableForms(selected).length}，点击可填入下方测试）：
            </span>
            <div className="tag-filter" style={{ marginTop: '0.3rem' }}>
              {getAcceptableForms(selected).map((f) => (
                <span key={f} className="badge" style={{ cursor: 'pointer' }} onClick={() => setTestInput(f)}>
                  {f}
                </span>
              ))}
            </div>
          </div>

          <div style={{ marginTop: '0.8rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>测试输入（判断是否判对）：</span>
            <div className="row" style={{ marginTop: '0.3rem', alignItems: 'center', gap: '0.5rem' }}>
              <input
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="输入要测试的写法…"
                style={{ flex: 1 }}
              />
              {testResult !== null && (
                <span className={testResult ? 'badge success' : 'badge'} style={{ whiteSpace: 'nowrap' }}>
                  {testResult ? '✓ 判对' : '✗ 判错'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: '0.8rem' }}>
        <h3 style={{ marginTop: 0 }}>Realtime 连通性自检</h3>
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
          课堂「多人同时在线」的选型前提。三项独立判定，因为它们在当前托管实例上并不一致
          （实测：连接 ✓ / Presence ✓ / Broadcast ✗）。若 Broadcast 失败并伴随 socket 断开，
          多半是服务端 <code>realtime.messages</code> 表「RLS 开着却没有策略」（默认全拒）——
          到控制台 Realtime Policies 建好策略后回来重测。
        </p>
        <div className="row" style={{ marginTop: '0.6rem', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <button className="primary" disabled={probe.conn === 'running'} onClick={runRealtimeProbe}>
            {probe.conn === 'running' ? '检测中…' : '开始检测'}
          </button>
          {(
            [
              ['conn', '连接'],
              ['presence', 'Presence'],
              ['broadcast', 'Broadcast'],
            ] as const
          ).map(([key, label]) => (
            <span
              key={key}
              className={probe[key] === 'ok' ? 'badge success' : probe[key] === 'fail' ? 'badge danger' : 'badge'}
            >
              {label} {probe[key] === 'ok' ? '✓' : probe[key] === 'fail' ? '✗' : probe[key] === 'running' ? '…' : '—'}
            </span>
          ))}
        </div>
        {probeLog.length > 0 && (
          <pre
            style={{
              marginTop: '0.5rem',
              marginBottom: 0,
              maxHeight: 190,
              overflow: 'auto',
              fontSize: '0.72rem',
              lineHeight: 1.5,
              background: 'var(--c-surface-soft)',
              padding: '0.5rem',
              borderRadius: 6,
            }}
          >
            {probeLog.join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
