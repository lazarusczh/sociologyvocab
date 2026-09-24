import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { fetchDailyStudy, type DailyStudy } from '../lib/xp';
import { pendingXpCount } from '../lib/xpQueue';
import { isDayChecked } from '../lib/checkin';
import type { CheckInState } from '../lib/types';

/**
 * XP「双跑对照」面板（开发后台内，仅 developer 可见）
 *
 * 目的：在把「打卡是否达标」的判定从**本地**切到**服务端**之前，
 *   先把两套口径的结果并排摆出来，让差异**立刻暴露**，而不是等切换后才由学生发现。
 *
 * 两侧的数据来源与口径：
 *   本地   `student_data.checkin.study`（前端自己算，学生目前用的口径）
 *   服务端 `get_daily_study()` = 基线 ∪ 事件 ∪ 补签（第④步要切过去的口径）
 *
 * ⚠ 达标判定**必须复用同一个 `isDayChecked`**（下方把服务端数据装进 CheckInState 形状再调用），
 *   不能用两套手写的门槛 —— 那样出现差异时分不清是「数据不同」还是「门槛写不同」。
 *
 * ⚠ 单位：本地 `seconds` 是**秒**，服务端 `ms` 是**毫秒**，展示时统一除以 1000。
 *
 * 已知**应当存在**的两类差异（不是 bug，方案 §六之七 已裁决）：
 *   ① 游客练习：本地有、服务端没有（服务端按 auth.uid() 归属，游客无归属对象）
 *   ② 离线未补报：事件还在本地队列里没发出去
 * 若差异只来自这两类，即可安全切换；出现其它差异才需要逐个排查。
 */
export default function XpShadowPanel() {
  const { checkin, authUser } = useStore();

  // 留空 = 查自己；填 uid = 查指定学生（developer 属 staff，服务端允许）
  const [targetUid, setTargetUid] = useState('');
  // ⚠ 默认 7 天，不要用 30：服务端事件从上线日才开始记，而基线只覆盖到上线前一天，
  //   更早的日子本地有记录、服务端两边都没有 ⇒ 一律显示成差异，一片红反而看不出真正的问题。
  //   7 天足以覆盖 "上线前 + 上线后" 的衔接区，也正好是一个自然的观察周期。
  const [days, setDays] = useState(7);
  const [server, setServer] = useState<DailyStudy[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const lookingAtSelf = !targetUid.trim() || targetUid.trim() === authUser?.id;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchDailyStudy(targetUid.trim() || undefined);
      setServer(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setServer(null);
    } finally {
      setLoading(false);
    }
  }, [targetUid]);

  useEffect(() => {
    void load();
  }, [load]);

  // 把服务端逐日数据装进 CheckInState 形状，**复用 isDayChecked** ⇒ 门槛与本地完全一致
  const serverAsState: CheckInState = useMemo(() => {
    const study: Record<string, { seconds: number; questions: number; correct: number }> = {};
    const makeup: Record<string, true> = {};
    for (const d of server ?? []) {
      study[d.day_key] = {
        seconds: Math.round(d.ms / 1000), // ⚠ 毫秒 → 秒
        questions: d.questions,
        correct: d.correct,
      };
      if (d.makeup) makeup[d.day_key] = true;
    }
    return { study, makeup, earnedMakeupWeeks: [], bestStreak: 0 };
  }, [server]);

  /** 逐日对照行：取两侧日期并集，降序，只保留最近 `days` 天 */
  const rows = useMemo(() => {
    const all = new Set<string>();
    for (const k of Object.keys(checkin.study)) all.add(k);
    for (const k of Object.keys(checkin.makeup)) all.add(k);
    for (const d of server ?? []) all.add(d.day_key);

    return [...all]
      .sort()
      .reverse()
      .slice(0, days)
      .map((day) => {
        // 本地（只有查自己时才有意义）
        const l = lookingAtSelf ? checkin.study[day] : undefined;
        const lMakeup = lookingAtSelf ? !!checkin.makeup[day] : false;
        // 服务端
        const s = (server ?? []).find((x) => x.day_key === day);
        const sMakeup = !!s?.makeup;

        const localChecked = lookingAtSelf ? isDayChecked(checkin, day) : null;
        const serverChecked = isDayChecked(serverAsState, day);

        const localQ = l?.questions ?? 0;
        const serverQ = s?.questions ?? 0;
        const localSec = l?.seconds ?? 0;
        const serverSec = s ? Math.round(s.ms / 1000) : 0;

        // ★ 「差异」只定义为**达标状态不同** —— 那才是第④步真正要切的东西。
        const checkMismatch = localChecked !== null && localChecked !== serverChecked;

        // 题数不等：**独立的次级提示**（反映事件是否到齐：队列未发 / 被拒 / 游客）。
        // 不并入「差异」，因为它与「达标口径不一致」是两种完全不同的问题。
        const qtyDiff = lookingAtSelf && localQ !== serverQ;

        // ⚠ 时长**不参与任何判定**。两侧口径结构性不同：
        //   本地 `seconds` 由 useStudySession 每 10 秒累加（含看解析、停顿、走神）；
        //   服务端 `ms` 是每题「呈现→提交」区间之和（next() 会 reset，不含看解析）。
        //   ⇒ 它们本来就不该相等，拿差值当判据只会天天误报。
        //   何况表格按分钟显示，差 6~59 秒时"显示相同却报差异"，最容易被误读成 bug。

        return {
          day,
          localQ,
          serverQ,
          localSec,
          serverSec,
          localChecked,
          serverChecked,
          localMakeup: lMakeup,
          serverMakeup: sMakeup,
          mismatch: checkMismatch,
          qtyDiff,
        };
      });
  }, [checkin, server, serverAsState, days, lookingAtSelf]);

  const summary = useMemo(() => {
    const both = rows.filter((r) => r.localChecked !== null);
    return {
      total: rows.length,
      localChecked: both.filter((r) => r.localChecked).length,
      serverChecked: rows.filter((r) => r.serverChecked).length,
      mismatch: rows.filter((r) => r.mismatch).length,   // 达标口径不一致
      qtyDiff: rows.filter((r) => r.qtyDiff).length,     // 题数不等（事件未到齐）
      localDays: lookingAtSelf ? Object.keys(checkin.study).length : 0,
      serverDays: (server ?? []).length,
    };
  }, [rows, checkin, server, lookingAtSelf]);

  const pending = lookingAtSelf ? pendingXpCount() : 0;

  return (
    // ⚠ 必须带 marginTop：上一张卡片（Realtime 自检）的 marginBottom 为 0，
    //   只写 marginBottom 会让两张卡片贴在一起（外边距折叠只在相邻 margin 间发生）。
    <div className="card" style={{ marginTop: '0.8rem', marginBottom: '0.8rem' }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>XP 双跑对照</h3>
        <span className="spacer" />
        <button className="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.35rem' }}>
        并排显示<strong>本地算</strong>与<strong>服务端算</strong>的打卡结果。
        <strong>「达标不一致」只表示两边结论不同</strong>（那才是切换判定真正要保证一致的）；
        「题数不等」单独标出，反映事件是否到齐（队列未发 / 被拒 / 游客）；
        <strong>时长不参与判定</strong> —— 本地按页面停留累计、服务端按作答区间求和，口径不同，本就无法相等。
      </p>

      <div className="row tight" style={{ marginTop: '0.5rem', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
          目标 uid
          <input
            type="text"
            value={targetUid}
            onChange={(e) => setTargetUid(e.target.value)}
            placeholder="留空 = 自己"
            style={{ width: '17rem', fontFamily: 'monospace', fontSize: '0.8rem' }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
          近
          <input
            type="number"
            min={1}
            max={400}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(400, Number(e.target.value) || 7)))}
            style={{ width: '4.5rem' }}
          />
          天
        </label>
      </div>

      {error && (
        <p className="badge danger" style={{ marginTop: '0.5rem' }}>
          服务端读取失败：{error}
        </p>
      )}

      <div className="row tight" style={{ marginTop: '0.5rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
        <span className="badge">对比天数 {summary.total}</span>
        <span className="badge">本地达标 {summary.localChecked}</span>
        <span className="badge success">服务端达标 {summary.serverChecked}</span>
        <span className={summary.mismatch > 0 ? 'badge danger' : 'badge success'}>
          达标不一致 {summary.mismatch}
        </span>
        {lookingAtSelf && (
          <span className={summary.qtyDiff > 0 ? 'badge warn' : 'badge'}>
            题数不等 {summary.qtyDiff}
          </span>
        )}
        {lookingAtSelf && <span className="badge">本地记录 {summary.localDays} 天</span>}
        <span className="badge">服务端记录 {summary.serverDays} 天</span>
        {lookingAtSelf && (
          <span className={pending > 0 ? 'badge warn' : 'badge'}>待同步 {pending} 条</span>
        )}
      </div>

      {!loading && rows.length === 0 && (
        <p className="empty-state" style={{ marginTop: '0.5rem' }}>
          没有可比对的数据。本地与服务端都还没有这段时间的记录。
        </p>
      )}

      {rows.length > 0 && (
        <div style={{ padding: 0, overflowX: 'auto', marginTop: '0.5rem' }}>
          <table className="check-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>本地题数</th>
                <th>服务端题数</th>
                <th>本地时长</th>
                <th>服务端时长</th>
                <th>本地达标</th>
                <th>服务端达标</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.day}
                  style={
                    r.mismatch
                      ? { background: 'rgba(220, 80, 80, 0.12)' }   // 红：达标结论不同（要查）
                      : r.qtyDiff
                        ? { background: 'rgba(230, 170, 40, 0.12)' } // 黄：题数不齐（事件未到）
                        : undefined
                  }
                >
                  <td>{r.day}</td>
                  <td>{lookingAtSelf ? r.localQ : '—'}</td>
                  <td>{r.serverQ}</td>
                  <td>{lookingAtSelf ? formatDur(r.localSec) : '—'}</td>
                  <td>{formatDur(r.serverSec)}</td>
                  <td>{r.localChecked === null ? '—' : r.localChecked ? '✔' : '✘'}</td>
                  <td>{r.serverChecked ? '✔' : '✘'}</td>
                  <td style={{ fontSize: '0.8rem' }}>
                    {r.localMakeup || r.serverMakeup ? <span className="badge">补签</span> : ''}
                    {r.mismatch ? <span className="badge danger">达标不一致</span> : ''}
                    {r.qtyDiff ? <span className="badge warn">题数不等</span> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 秒 → 时长文本。≥2 分钟显示 `Xm`（带余秒），否则显示 `Xs`。
 *
 *  ⚠ 两侧时长口径不同（本地按页面停留累计、服务端按作答区间求和），**不参与判定**。
 *     这里保留秒级精度，只是为了让「差多少」一眼可见 —— 之前只显示到分钟，
 *     导致"显示相同却报差异"的困惑。 */
function formatDur(sec: number): string {
  if (!sec) return '0s';
  if (sec < 120) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}
