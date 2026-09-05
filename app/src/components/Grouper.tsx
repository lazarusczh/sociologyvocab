import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { listQuestionBank, createGrouperRun, type QbRow } from '../lib/cloud';
import {
  assembleTemplate, assembleToTarget, pickSingle, TEMPLATES,
  type AssembleSlot, type BankItem, type PaperId,
} from '../lib/grouper';
import {
  bandLinear, buildRows, deriveRowsP1, scaleThresholds,
  type GtList, type ThresholdRows,
} from '../lib/score';

const toItem = (r: QbRow): BankItem => ({
  qid: r.qid,
  source: { session: r.session, paper: r.paper, variant: r.variant, comp: r.comp, q: r.q },
  stem: r.stem,
  statement: r.statement,
  marks: r.marks,
  marksTotal: r.marks_total,
  kind: r.kind as BankItem['kind'],
  parts: r.parts as BankItem['parts'],
  topics: r.topics ?? [],
});

type Mode = 'template' | 'single' | 'free';

export default function Grouper({ onOpenResults }: { onOpenResults?: () => void }) {
  const { authUser } = useStore();
  const [mode, setMode] = useState<Mode>('template');
  const [paper, setPaper] = useState<PaperId>(1);
  const [templateIdx, setTemplateIdx] = useState(0);
  const [topic, setTopic] = useState('');
  const [target, setTarget] = useState('20');
  const [singleQ, setSingleQ] = useState('');
  const [bank, setBank] = useState<BankItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ slots: AssembleSlot[]; note: string } | null>(null);
  const [single, setSingle] = useState<BankItem | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [rawItems, setRawItems] = useState<BankItem[]>([]);
  const [fullRaw, setFullRaw] = useState(60);
  const [gt, setGt] = useState<GtList>([]);
  const [modeScore, setModeScore] = useState<'p1' | 'p0'>('p1');
  const [series, setSeries] = useState('');
  const [aStar, setAStar] = useState('');
  const [sampleRaw, setSampleRaw] = useState('20');

  useEffect(() => {
    let cancelled = false;
    fetch('/gt-templates.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((d: GtList) => {
        if (cancelled || !d.length) return;
        setGt(d);
        setSeries((cur) => cur || d.find((e) => e.components[`${paper}3`])?.series || d[0].series);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paperTemplates = TEMPLATES.filter((t) => t.paper === paper);
  const template = paperTemplates[Math.min(templateIdx, paperTemplates.length - 1)];

  const loadBank = async (p: PaperId) => {
    try {
      const rows = await listQuestionBank({ paper: p });
      setBank(rows.map(toItem));
      setError('');
    } catch (e) {
      setError((e as Error).message || '加载题库失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadBank(paper); }, [paper]);

  const switchPaper = (p: PaperId) => {
    if (p === paper) return;
    setTemplateIdx(0);
    setResult(null);
    setSingle(null);
    setSingleQ('');
    setLoading(true);
    setError('');
    setPaper(p);
  };

  const topics = useMemo(() => {
    const s = new Set<string>();
    for (const it of bank) if (it.topics[0]) s.add(it.topics[0]);
    return [...s].sort();
  }, [bank]);
  const marksOptions = useMemo(() => {
    const s = [...new Set(bank.map((b) => b.marks))];
    const total = (m: string) => (m.match(/\d+/g) || []).reduce((a, b) => a + Number(b), 0);
    return s.sort((a, b) => total(a) - total(b));
  }, [bank]);

  const resetSaved = () => { setSaveOpen(false); setSavedMsg(''); };

  const doAssemble = () => {
    if (!template) return;
    resetSaved();
    const res = assembleTemplate(bank, template, topic || undefined);
    const ok = res.slots.every((s) => s.items.length >= s.spec.count);
    setRawItems(res.slots.flatMap((s) => s.items));
    setFullRaw(res.total);
    setResult({ slots: res.slots, note: ok ? `组卷完成 · 总分 ${res.total}` : '题库不足：部分槽位未凑满' });
  };

  const doFree = () => {
    resetSaved();
    const t = Number(target) || 0;
    const slots = assembleToTarget(bank, t, topic || undefined);
    if (slots) setRawItems(slots.flatMap((s) => s.items));
    setFullRaw(t);
    setResult(slots ? { slots, note: `凑分成功 · 目标 ${t}` } : { slots: [], note: `无法用现有分值块凑出 ${t}（可放宽考点筛选）` });
  };

  const doSingle = () => {
    resetSaved();
    const it = pickSingle(bank, paper, {
      marks: singleQ || undefined,
      topic: topic || undefined,
    });
    setSingle(it ?? null);
    setRawItems(it ? [it] : []);
    setFullRaw(it?.marksTotal ?? 0);
    setResult(it
      ? { slots: [], note: `已抽一题 · ${it.marks} 分（${it.source.session} QP${it.source.comp}${it.source.q ? ' Q' + it.source.q : ''}）` }
      : { slots: [], note: '未抽到符合条件的题（可放宽分值 / 考点）' });
  };

  const srcLabelFor = (it: BankItem) => `${it.source.session} QP${it.source.comp}${it.source.q ? ' Q' + it.source.q : ''}`;

  // 换一个：在槽位内按同分值/题型从「当前未被占用」的题库中另抽一题
  const swapInSlot = (slotKey: string, oldQid: string) => {
    if (!result) return;
    const idx = result.slots.findIndex((s) => s.spec.key === slotKey);
    if (idx < 0) return;
    const spec = result.slots[idx].spec;
    const used = new Set(result.slots.flatMap((s) => s.items.map((it) => it.qid)));
    used.delete(oldQid);
    const pool = bank.filter((it) =>
      !used.has(it.qid) &&
      (!spec.kind || it.kind === spec.kind) &&
      it.marks === spec.marks &&
      (mode === 'template' ? it.source.paper === paper : true) &&
      (topic ? it.topics.includes(topic) : true),
    );
    const pick = [...pool].sort(() => Math.random() - 0.5)[0];
    if (!pick) {
      setError(`没有可替换的「${spec.label}」备选题（当前筛选范围已无可抽的 ${spec.marks} 分题）`);
      return;
    }
    const slots = result.slots.map((s, i) => (
      i === idx ? { ...s, items: s.items.map((it) => (it.qid === oldQid ? pick : it)) } : s
    ));
    setResult({ ...result, slots, note: `${result.note} · 已换 ${pick.marks} 分题` });
    setRawItems(slots.flatMap((s) => s.items));
    resetSaved();
    setError('');
  };

  // 单题布置：按当前筛选条件排除本题另抽
  const swapSingle = (oldQid: string) => {
    const it = pickSingle(bank.filter((b) => b.qid !== oldQid), paper, {
      marks: singleQ || undefined,
      topic: topic || undefined,
    });
    if (!it) {
      setError('该分值/考点下题库已没有其它题可抽');
      return;
    }
    setSingle(it);
    setRawItems([it]);
    setFullRaw(it.marksTotal);
    setResult({ slots: [], note: `已抽一题 · ${it.marks} 分（${it.source.session} QP${it.source.comp}${it.source.q ? ' Q' + it.source.q : ''}）` });
    resetSaved();
    setError('');
  };

  const renderItem = (it: BankItem, onSwap?: () => void) => (
    <div className="card" key={it.qid} style={{ padding: '0.6rem 0.8rem', margin: '0.4rem 0' }}>
      <div className="row" style={{ gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="badge">{srcLabelFor(it)}</span>
        <span className="badge warn">{it.marks} 分</span>
        <span className="badge review">{it.kind}</span>
      </div>
      {it.statement && <p className="ppt-stmt" style={{ margin: '0.3rem 0 0.1rem' }}>{it.statement}</p>}
      <p className={it.statement ? 'muted' : ''} style={{ margin: '0.2rem 0 0', fontSize: '0.9rem' }}>{it.stem}</p>
      <div className="row" style={{ gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.35rem', alignItems: 'center' }}>
        {it.topics.slice(-2).map((t) => <span key={t} className="ppt-tag" style={{ color: 'var(--c-stone)' }}>{t}</span>)}
        <span className="muted" style={{ fontSize: '0.75rem' }}>ms 见「试卷成绩」</span>
        {onSwap && (
          <button
            className="grp-btn"
            style={{ fontSize: '0.75rem', padding: '0.15rem 0.5rem', marginLeft: 'auto' }}
            onClick={onSwap}
          >
            换一个
          </button>
        )}
      </div>
    </div>
  );

  const score = useMemo(() => {
    if (!rawItems.length || gt.length === 0) return null;
    const srcs = rawItems.map((it) => ({ series: it.source.session, comp: it.source.comp, weight: 1 }));
    const p1 = deriveRowsP1(gt, srcs, fullRaw);
    const entry = gt.find((e) => e.series === series);
    const compRow = entry?.components?.[`${paper}3`];
    const t: ThresholdRows = modeScore === 'p0' && compRow ? scaleThresholds(compRow, fullRaw) : p1;
    const aStarVal = aStar.trim() === '' ? null : Math.max(0, Math.round(Number(aStar) || 0));
    const rows = buildRows(t, fullRaw, aStarVal);
    const sRaw = Math.max(0, Number(sampleRaw) || 0);
    const conv = bandLinear(sRaw, fullRaw, rows);
    return { t, rows, conv, p0ok: !!compRow, p1, fullRaw };
  }, [rawItems, gt, series, modeScore, fullRaw, aStar, sampleRaw, paper]);

  const defaultTitle = () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const base = mode === 'template'
      ? (template?.label ?? `Paper ${paper} 全卷`)
      : mode === 'single'
        ? (single ? `单题布置 · ${single.source.session} QP${single.source.comp}${single.source.q ? ' Q' + single.source.q : ''}（${single.marks} 分）` : '单题布置')
        : '目标凑分';
    return `${base} ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const openSave = () => {
    setError('');
    setSaveTitle(defaultTitle());
    setSaveOpen(true);
  };

  const doSave = async () => {
    if (!result || !score) return;
    setSaving(true);
    setError('');
    try {
      const title = saveTitle.trim() || defaultTitle();
      await createGrouperRun({
        title,
        mode,
        paper,
        template_label: mode === 'template'
          ? (template?.label ?? null)
          : mode === 'single'
            ? (single ? `${single.source.session} QP${single.source.comp}${single.source.q ? ' Q' + single.source.q : ''}（${single.marks} 分）` : '单题布置')
            : '目标凑分',
        topic: topic.trim() || null,
        slots: mode === 'single'
          ? (single ? [{ spec: { key: 'single', label: '单题布置', marks: single.marks, marksTotal: single.marksTotal, count: 1 }, items: [single] }] : [])
          : result.slots,
        full_raw: score.fullRaw,
        thresholds: { A: score.t.A, B: score.t.B, C: score.t.C, D: score.t.D, E: score.t.E },
        a_star: aStar.trim() === '' ? null : Math.max(0, Math.round(Number(aStar) || 0)),
        created_by: authUser?.id ?? null,
      });
      setSavedMsg(`已保存「${title}」`);
      setSaveOpen(false);
    } catch (e) {
      setError((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>组卷器</h3>
          <span className="spacer" />
          {loading && <span className="muted" style={{ fontSize: '0.85rem' }}>加载题库中…</span>}
        </div>
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          从历年真题题库选题组卷（真题模板 / 单题布置 / 目标凑分），出卷后按题目真实来源与当次满分换算等第。
          需要正式考试的卷可「保存本卷」——之后到「试卷成绩」回访卷面、对照 ms 阅卷并登记学生成绩。
        </p>
        {error && (
          <div className="card" style={{ marginTop: '0.6rem', padding: '0.5rem 0.7rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
            {error}
          </div>
        )}
        <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.7rem' }}>
          {(['template', 'single', 'free'] as Mode[]).map((m) => (
            <button key={m} className={`grp-btn ${mode === m ? 'active' : ''}`} onClick={() => { setMode(m); setResult(null); }}>
              {m === 'template' ? '真题模板' : m === 'single' ? '单题布置' : '目标凑分'}
            </button>
          ))}
          <span style={{ marginLeft: '0.5rem' }} />
          {[1, 2, 3, 4].map((p) => (
            <button key={p} className={`grp-btn ${paper === p ? 'active' : ''}`} onClick={() => switchPaper(p as PaperId)}>P{p}</button>
          ))}
          <span style={{ marginLeft: '0.5rem' }} />
          <span className="muted" style={{ fontSize: '0.85rem' }}>考点：</span>
          <select className="grp-input" value={topic} onChange={(e) => setTopic(e.target.value)}>
            <option value="">全部</option>
            {topics.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {mode === 'template' && paperTemplates.length > 0 && (
          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
            {paperTemplates.map((t, i) => (
              <button key={t.id} className={`grp-btn ${i === templateIdx ? 'active' : ''}`} onClick={() => setTemplateIdx(i)}>{t.label}</button>
            ))}
            <button className="grp-go" onClick={doAssemble}>自动组卷</button>
          </div>
        )}
        {mode === 'single' && (
          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>分值：</span>
            <select className="grp-input" value={singleQ} onChange={(e) => setSingleQ(e.target.value)}>
              <option value="">任意</option>
              {marksOptions.map((m) => <option key={m} value={m}>{m} 分</option>)}
            </select>
            <button className="grp-go" onClick={doSingle}>抽一题</button>
          </div>
        )}
        {mode === 'free' && (
          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>目标原始分：</span>
            <input className="grp-input" style={{ width: '4.5rem' }} value={target} onChange={(e) => setTarget(e.target.value)} />
            <button className="grp-go" onClick={doFree}>自动凑分</button>
          </div>
        )}
        {mode === 'template' && template && (
          <p className="muted" style={{ fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
            {template.label} · 槽位：{template.slots.map((s) => `${s.label}(${s.marks}${s.eitherOr ? '×2选1' : ''})`).join(' / ')}
          </p>
        )}
      </div>
      {result && <p className="badge success">{result.note}</p>}
      {result && !score && <p className="muted" style={{ fontSize: '0.85rem' }}>（暂无分数线数据，暂不能保存为试卷）</p>}
      {result && score && (
        <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', margin: '0.5rem 0 0.6rem', alignItems: 'center' }}>
          {!saveOpen && <button className="grp-go" onClick={openSave}>保存本卷</button>}
          {!saveOpen && savedMsg && <span className="badge success">{savedMsg}</span>}
          {!saveOpen && savedMsg && onOpenResults && (
            <button className="grp-btn" onClick={onOpenResults}>去「试卷成绩」登记成绩</button>
          )}
          {saveOpen && (
            <div className="card" style={{ padding: '0.6rem 0.8rem', margin: 0, width: '100%' }}>
              <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: '0.85rem' }}>卷名：</span>
                <input
                  className="grp-input" style={{ flex: '1 1 12rem', minWidth: '10rem' }}
                  value={saveTitle} onChange={(e) => setSaveTitle(e.target.value)}
                />
                <button className="grp-go" onClick={() => void doSave()} disabled={saving}>
                  {saving ? '保存中…' : '确认保存'}
                </button>
                <button className="grp-btn" onClick={() => setSaveOpen(false)}>取消</button>
              </div>
              <p className="muted" style={{ margin: '0.4rem 0 0', fontSize: '0.8rem' }}>
                卷面快照 + 当前分数线（满分 {score.fullRaw}，按「{modeScore === 'p1' ? '来源 P1' : 'P0 基线'}」口径）将上云保存；
                保存后到「试卷成绩」回访阅卷、登记学生卷面分并自动换算百分制。
              </p>
            </div>
          )}
        </div>
      )}
      {mode === 'template' && result && result.slots.map((s) => (
        <div key={s.spec.key} style={{ marginTop: '0.6rem' }}>
          <div className="collapse-head" style={{ fontSize: '0.95rem' }}>
            <span>{s.spec.label}</span>
            <span className="ppt-count">{s.items.length}/{s.spec.count}</span>
          </div>
          {s.items.length === 0 && <div className="muted" style={{ fontSize: '0.85rem' }}>该槽没有可用题</div>}
          {s.items.map((it) => renderItem(it, () => swapInSlot(s.spec.key, it.qid)))}
        </div>
      ))}
      {mode === 'free' && result && result.slots.length === 0 && <div className="empty-state">{result.note}</div>}
      {mode === 'free' && result && result.slots.length > 0 && result.slots.map((s) => (
        <div key={s.spec.key} style={{ marginTop: '0.6rem' }}>
          <div className="collapse-head" style={{ fontSize: '0.95rem' }}><span>{s.spec.label} ×{s.items.length}</span></div>
          {s.items.map((it) => renderItem(it, () => swapInSlot(s.spec.key, it.qid)))}
        </div>
      ))}
      {mode === 'single' && single && renderItem(single, () => swapSingle(single.qid))}

      {score && (
        <div className="card" style={{ marginTop: '1rem', padding: '0.8rem' }}>
          <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.4rem' }}>
            <strong>分数线换算 · 当次满分 {fullRaw}</strong>
            <span style={{ display: 'inline-flex', gap: '0.3rem' }}>
              <button className={`grp-btn ${modeScore === 'p1' ? 'active' : ''}`} onClick={() => setModeScore('p1')}>按来源 P1</button>
              <button className={`grp-btn ${modeScore === 'p0' ? 'active' : ''}`} onClick={() => setModeScore('p0')}>P0 基线</button>
            </span>
          </div>
          {modeScore === 'p0' && (
            <div className="row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
              <span className="muted">gt 系列</span>
              <select className="grp-input" value={series} onChange={(e) => setSeries(e.target.value)}>
                {gt.map((g) => <option key={g.series} value={g.series}>{g.series}</option>)}
              </select>
              {score.p0ok
                ? <span className="muted">用 {paper}3（variant3）按满分比缩放到 {fullRaw}</span>
                : <span className="badge danger">该系列无 {paper}3 行</span>}
            </div>
          )}
          {modeScore === 'p1' && (
            <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 0.4rem' }}>
              按被选题真实来源聚合（每题 1 票）→ 套用满分 {fullRaw}
            </p>
          )}
          <table className="grp-score-table">
            <thead><tr><th>等级</th><th>原始分下限</th><th>换算（100 分制）</th></tr></thead>
            <tbody>
              {score.rows.map((r) => (
                <tr key={r.grade}>
                  <td>{r.grade}</td>
                  <td>
                    {r.grade === 'A*'
                      ? <input className="grp-input" placeholder="教师定" value={aStar} onChange={(e) => setAStar(e.target.value)} />
                      : (r.cieRaw ?? '—')}
                  </td>
                  <td>{r.schoolPct}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            <span className="muted">原始分</span>
            <input className="grp-input" style={{ width: '4rem' }} value={sampleRaw} onChange={(e) => setSampleRaw(e.target.value)} />
            <span>→ <strong>{score.conv == null ? '（待填 A*）' : score.conv.toFixed(1)}</strong> / 100</span>
          </div>
        </div>
      )}
    </div>
  );
}
