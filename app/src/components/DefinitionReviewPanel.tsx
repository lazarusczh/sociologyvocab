// 定义题作答复核面板（教师后台）
//
// 背景：定义题已上线，但教师此前**看不到学生在普通练习里的实际作答**，
// 于是"模型判分与教师口径是否一致"无从验证 —— 而这正是它能否进入日常作业的关键前提。
// 本面板把真实作答（definition_attempts）摊开给教师逐条复核：
//   看学生实际写了什么、模型怎么判（含逐要素覆盖度、理由、档位与耗时），
//   再一键给出教师判定 + 备注。统计区实时显示**模型/教师一致率**。
//
// 数据与权限：表已具备 review / reviewed_by / reviewed_at 字段，RLS 亦已有
//   「教师/开发者可读全部 + 可更新」策略 —— 因此**无需任何数据库改动**。
//   本面板不引入任何新的取数逻辑，只复用既有表与策略。
//
// 统计口径：一致率 = 教师判定与模型 verdict 相同的比例（分母只算**已复核**的作答）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { maskEmail } from '../lib/shuffle';
import type { Verdict } from '../lib/ai';

interface AttemptRow {
  id: number;
  user_id: string;
  item_id: string;
  answer: string;
  verdict: string;
  coverage: number[] | null;
  listing_only: boolean | null;
  reason: string | null;
  confidence: number | null;
  model: string | null;
  tier: string | null;
  ms: number | null;
  review: string | null;
  reviewed_at: string | null;
  created_at: string;
}

interface ItemRow {
  id: string;
  term: string;
  chinese: string | null;
  units: string[] | null;
}

interface Review {
  verdict?: Verdict;
  note?: string;
}

const VERDICT_META: Record<string, { label: string; cls: string }> = {
  correct: { label: '正确', cls: 'badge success' },
  partial: { label: '部分正确', cls: 'badge warn' },
  wrong: { label: '未答对', cls: 'badge danger' },
};

const REVIEW_CHOICES: Verdict[] = ['correct', 'partial', 'wrong'];
const DEFAULT_TIER_NOTE: Record<string, string> = {
  nemotron: 'OpenRouter（ultra）',
  agnes: 'Agnes（免费）',
  ms: '魔搭（烧魔粒）',
  none: '全部档位失败',
};

/** review 字段兼容两种写法：JSON（{\"verdict\",\"note\"}）或直接是 verdict 字符串 */
function parseReview(raw: string | null): Review {
  if (!raw) return {};
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as Review;
      return { verdict: o.verdict, note: o.note };
    } catch {
      /* 解析失败则按纯文本处理 */
    }
  }
  if (t === 'correct' || t === 'partial' || t === 'wrong') return { verdict: t };
  return { note: t };
}

const serializeReview = (r: Review): string =>
  JSON.stringify({ verdict: r.verdict ?? null, note: r.note ?? '' });

/** 覆盖度渲染：1 / 0.5 / 0 —— 保留一位小数，空数组显示为 — */
const fmtCoverage = (c: number[] | null): string => {
  if (!Array.isArray(c) || c.length === 0) return '—';
  return c.map((x) => (Number.isFinite(x) ? String(Number(x)) : '?')).join(' / ');
};

export default function DefinitionReviewPanel() {
  const [rows, setRows] = useState<AttemptRow[]>([]);
  const [itemMap, setItemMap] = useState<Map<string, ItemRow>>(new Map());
  const [emails, setEmails] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<number | null>(null);

  // 筛选条件
  const [fUser, setFUser] = useState('all');
  const [fVerdict, setFVerdict] = useState('all');
  const [fReview, setFReview] = useState<'all' | 'todo' | 'done'>('todo');
  const [fText, setFText] = useState('');

  // 备注草稿（按作答 id 暂存，未保存前的输入）
  const [notes, setNotes] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    // 教师/开发者身份由 RLS 放行，这里直接读全表（当前量级很小，取最近 1000 条足够）
    const { data, error: err } = await supabase
      .from('definition_attempts')
      .select('id, user_id, item_id, answer, verdict, coverage, listing_only, reason, confidence, model, tier, ms, review, reviewed_at, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (err) {
      setError(err.message);
      setRows([]);
      setLoading(false);
      return;
    }
    setRows((data ?? []) as unknown as AttemptRow[]);

    // 术语名与中文（用于让教师一眼看懂题目）——失败不影响主体功能
    const { data: itemRows } = await supabase
      .from('definition_items')
      .select('id, term, chinese, units');
    setItemMap(new Map(((itemRows ?? []) as unknown as ItemRow[]).map((r) => [r.id, r])));

    // 学生邮箱映射（display 用；没有则退回 user_id 短标识）
    const { data: sd } = await supabase.from('student_data').select('user_id, email');
    setEmails(new Map(((sd ?? []) as { user_id: string; email: string }[]).map((r) => [r.user_id, r.email])));

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const labelOfUser = useCallback(
    (uid: string) => {
      const email = emails.get(uid);
      return email ? maskEmail(email) : `…${uid.slice(-6)}`;
    },
    [emails],
  );

  const save = useCallback(
    async (row: AttemptRow, verdict: Verdict | null) => {
      setSavingId(row.id);
      setError('');
      const prev = parseReview(row.review);
      const note = (notes[row.id] ?? prev.note ?? '').trim();
      const { data: auth } = await supabase.auth.getUser();
      const payload = {
        review: verdict ? serializeReview({ verdict, note }) : null,
        reviewed_by: verdict ? auth.user?.id ?? null : null,
        reviewed_at: verdict ? new Date().toISOString() : null,
      };
      const { error: err } = await supabase.from('definition_attempts').update(payload).eq('id', row.id);
      setSavingId(null);
      if (err) {
        setError(`保存失败：${err.message}`);
        return;
      }
      setRows((prevRows) =>
        prevRows.map((r) => (r.id === row.id ? { ...r, review: payload.review, reviewed_at: payload.reviewed_at } : r)),
      );
      setNotes((n) => {
        const next = { ...n };
        delete next[row.id];
        return next;
      });
    },
    [notes],
  );

  // ===== 统计（基于全部作答，而非筛选后，避免筛选把分母改掉）=====
  const stats = useMemo(() => {
    const reviewed = rows.filter((r) => Boolean(parseReview(r.review).verdict));
    const agree = reviewed.filter((r) => parseReview(r.review).verdict === r.verdict);
    return {
      total: rows.length,
      reviewed: reviewed.length,
      agree: agree.length,
      rate: reviewed.length ? Math.round((agree.length / reviewed.length) * 100) : 0,
    };
  }, [rows]);

  const userOptions = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r) => m.set(r.user_id, (m.get(r.user_id) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const shown = useMemo(() => {
    const kw = fText.trim().toLowerCase();
    return rows.filter((r) => {
      if (fUser !== 'all' && r.user_id !== fUser) return false;
      if (fVerdict !== 'all' && r.verdict !== fVerdict) return false;
      const rv = parseReview(r.review).verdict;
      if (fReview === 'todo' && rv) return false;
      if (fReview === 'done' && !rv) return false;
      if (kw) {
        const it = itemMap.get(r.item_id);
        const hay = `${r.item_id} ${it?.term ?? ''} ${it?.chinese ?? ''} ${r.answer}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [rows, fUser, fVerdict, fReview, fText, itemMap]);

  return (
    <div>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>定义题作答复核</h3>
          <span className="spacer" />
          <button className="ghost" onClick={load} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
        <p className="muted" style={{ marginTop: '0.4rem' }}>
          学生在定义题练习里的<strong>真实作答</strong>与模型判分。请逐条给出你的判定 ——
          一致率越高，说明模型口径越接近教师口径，定义题越有条件作为日常作业计分。
        </p>
        <div className="grid cols-4" style={{ marginTop: '0.6rem' }}>
          <div className="stat"><span className="num">{stats.total}</span><span className="label">作答总数</span></div>
          <div className="stat"><span className="num">{stats.reviewed}</span><span className="label">已复核</span></div>
          <div className="stat"><span className="num">{stats.agree}</span><span className="label">与模型一致</span></div>
          <div className="stat"><span className="num">{stats.rate}%</span><span className="label">一致率</span></div>
        </div>

        <div className="tag-filter" style={{ marginTop: '0.6rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>复核状态：</span>
          <button className={fReview === 'todo' ? 'active' : ''} onClick={() => setFReview('todo')}>待复核</button>
          <button className={fReview === 'done' ? 'active' : ''} onClick={() => setFReview('done')}>已复核</button>
          <button className={fReview === 'all' ? 'active' : ''} onClick={() => setFReview('all')}>全部</button>
          <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center', marginLeft: '0.6rem' }}>模型判定：</span>
          {['all', 'correct', 'partial', 'wrong'].map((v) => (
            <button key={v} className={fVerdict === v ? 'active' : ''} onClick={() => setFVerdict(v)}>
              {v === 'all' ? '全部' : VERDICT_META[v]?.label ?? v}
            </button>
          ))}
        </div>

        <div className="row" style={{ marginTop: '0.5rem', gap: '0.5rem', flexWrap: 'wrap' }}>
          <select value={fUser} onChange={(e) => setFUser(e.target.value)}>
            <option value="all">全部学生（{rows.length} 条）</option>
            {userOptions.map(([uid, n]) => (
              <option key={uid} value={uid}>{labelOfUser(uid)}（{n} 条）</option>
            ))}
          </select>
          <input
            placeholder="搜索术语 / 答案关键词"
            value={fText}
            onChange={(e) => setFText(e.target.value)}
            style={{ flex: 1, minWidth: '12rem' }}
          />
          <span className="muted" style={{ fontSize: '0.85rem', alignSelf: 'center' }}>符合条件 {shown.length} 条</span>
        </div>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: '0.8rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
          {error}
        </div>
      )}

      {!loading && !error && shown.length === 0 && (
        <div className="card"><div className="empty-state">
          <div className="big">📝</div>
          <p className="muted">当前条件下没有作答记录。学生练习定义题后会自动出现在这里。</p>
        </div></div>
      )}

      {shown.map((r) => {
        const it = itemMap.get(r.item_id);
        const reviewed = parseReview(r.review);
        const meta = VERDICT_META[r.verdict];
        const agree = reviewed.verdict ? reviewed.verdict === r.verdict : null;
        return (
          <div key={r.id} className="card" style={{ marginBottom: '0.7rem' }}>
            <div className="row" style={{ alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
              <strong>{it?.term ?? r.item_id}</strong>
              {it?.chinese && <span className="muted">{it.chinese}</span>}
              <span className={meta?.cls ?? 'badge'}>{meta?.label ?? r.verdict}</span>
              {agree === true && <span className="badge success" title="你的判定与模型一致">一致</span>}
              {agree === false && <span className="badge danger" title="你的判定与模型不同">不一致</span>}
              <span className="spacer" />
              <span className="muted" style={{ fontSize: '0.78rem' }}>
                {labelOfUser(r.user_id)} · {new Date(r.created_at).toLocaleString()}
              </span>
            </div>

            <p style={{ margin: '0.45rem 0 0.3rem', whiteSpace: 'pre-wrap' }}>{r.answer}</p>

            <p className="muted" style={{ margin: '0.2rem 0', fontSize: '0.82rem' }}>
              逐要素覆盖度：{fmtCoverage(r.coverage)}
              {r.listing_only ? ' · 仅罗列关键词' : ''}
              {r.reason ? ` · ${r.reason}` : ''}
            </p>
            <p className="muted" style={{ margin: '0 0 0.5rem', fontSize: '0.76rem' }}>
              {DEFAULT_TIER_NOTE[r.tier ?? ''] ?? r.tier ?? '未知档'} · {r.model ?? '—'}
              {r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ''}
            </p>

            <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: '0.85rem' }}>教师判定：</span>
              {REVIEW_CHOICES.map((v) => (
                <button
                  key={v}
                  className={reviewed.verdict === v ? 'active' : 'ghost'}
                  disabled={savingId === r.id}
                  onClick={() => save(r, v)}
                >
                  {VERDICT_META[v].label}
                </button>
              ))}
              {reviewed.verdict && (
                <button className="ghost" disabled={savingId === r.id} onClick={() => save(r, null)}>
                  清除
                </button>
              )}
              <input
                placeholder="备注（可选，随判定一起保存）"
                value={notes[r.id] ?? reviewed.note ?? ''}
                onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                style={{ flex: 1, minWidth: '12rem' }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
