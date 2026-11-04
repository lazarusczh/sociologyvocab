// 组内问卷：一张题目卡片（学生端编辑器 / 只读视图共用）
//
// 口径（见《模拟调研实装方案.md》第五节）：
//   · 一题一卡；输入 600ms 防抖后自动保存（保存的是这一行，不弹「已保存」）
//   · 题型切换保留题干与已填选项：单选 ↔ 多选共用选项；切到量表时两端文案保留
//   · 只有作者能改（服务端 RPC 也是这条口径），队友只读
//   · 保存失败原样显示服务端 message —— 不猜、不翻译成「网络问题」
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  optionKeyAt,
  questionError,
  saveQuestion,
  simErrorMessage,
  type SimOption,
  type SimQType,
} from '../lib/sim';

export interface EditableQuestion {
  id: string | null;
  qtype: SimQType;
  stem: string;
  options: SimOption[];
}

const QTYPES: { value: SimQType; label: string }[] = [
  { value: 'single', label: '单选' },
  { value: 'multi', label: '多选' },
  { value: 'scale', label: '程度量表' },
];

export const emptyOptions = (n = 2, labels: string[] = []): SimOption[] =>
  Array.from({ length: n }, (_, i) => ({ key: optionKeyAt(i, 'single'), label: labels[i] ?? '' }));

const reseq = (options: SimOption[], qtype: SimQType): SimOption[] =>
  options.map((o, i) => ({ key: optionKeyAt(i, qtype), label: o.label }));

// 切题型：单选 / 多选共用选项；量表压成 3 / 5 / 7 点，两端文案沿用首尾
export function convertOptions(options: SimOption[], to: SimQType, points = 5): SimOption[] {
  if (to === 'scale') {
    const n = points === 3 || points === 7 ? points : 5;
    const left = options[0]?.label ?? '';
    const right = options[options.length - 1]?.label ?? '';
    const mid: SimOption[] = Array.from({ length: n }, (_, i) => ({
      key: String(i + 1),
      label: i === 0 ? left : i === n - 1 ? right : '',
    }));
    return mid;
  }
  // 从量表切回来时，中间点没有文字 —— 直接丢掉，只留两端（否则会出现 3 行空白选项）
  const filled = options.filter((o) => o.label.trim() !== '');
  const base = (filled.length >= 2 ? filled : options).slice(0, 6);
  return reseq(base.length >= 2 ? base : emptyOptions(2), to);
}

const scalePoints = (options: SimOption[]): 3 | 5 | 7 =>
  options.length === 3 ? 3 : options.length === 7 ? 7 : 5;

// ---- 只读展示：队友的题、预览、冻结后的问卷都用这一份 ----
export function SimQuestionView({ q }: { q: { qtype: SimQType; stem: string; options: SimOption[] } }) {
  const scale = q.qtype === 'scale';
  return (
    <div>
      <p style={{ margin: '0.35rem 0 0.5rem', lineHeight: 1.55 }}>
        {q.stem.trim() || <span className="muted">（题干还没写完）</span>}
      </p>
      {scale ? (
        <div className="row" style={{ gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>{q.options[0]?.label || '左端'}</span>
          {q.options.map((o, i) => (
            <span key={o.key} className="badge">{i + 1}</span>
          ))}
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {q.options[q.options.length - 1]?.label || '右端'}
          </span>
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            （程度量表 · {q.options.length} 点）
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {q.options.map((o) => (
            <div key={o.key} className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
              <span className="badge">{o.key}</span>
              <span>{o.label.trim() || <span className="muted">（空选项）</span>}</span>
            </div>
          ))}
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {q.qtype === 'multi' ? '可多选' : '单选'} · 共 {q.options.length} 项
          </span>
        </div>
      )}
    </div>
  );
}

interface Props {
  sessionId: string;
  initial: EditableQuestion;
  index: number;
  canEdit: boolean;
  readOnly: boolean;
  readOnlyNote?: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onBound: (id: string) => void;
  onSaved: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1, current: EditableQuestion) => void;
}

export default function SimQuestionCard({
  sessionId,
  initial,
  index,
  canEdit,
  readOnly,
  readOnlyNote,
  canMoveUp,
  canMoveDown,
  onBound,
  onSaved,
  onDelete,
  onMove,
}: Props) {
  const [qid, setQid] = useState<string | null>(initial.id);
  const [qtype, setQtype] = useState<SimQType>(initial.qtype);
  const [stem, setStem] = useState(initial.stem);
  const [options, setOptions] = useState<SimOption[]>(initial.options);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  // 回调放 ref：避免父组件每次重渲染都重置防抖计时
  const cb = useRef({ onBound, onSaved });
  cb.current = { onBound, onSaved };

  // 已经落库的内容：用序列化比较，避免挂载即保存
  const savedRef = useRef(JSON.stringify({ qtype: initial.qtype, stem: initial.stem.trim(), options: reseq(initial.options, initial.qtype) }));
  const aliveRef = useRef(true);
  const savingRef = useRef(false);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const payloadOf = useCallback(
    (t: SimQType, s: string, o: SimOption[]) => ({
      qtype: t,
      stem: s.trim(),
      options: reseq(o, t),
    }),
    [],
  );

  const flush = useCallback(
    async (t: SimQType, s: string, o: SimOption[]): Promise<boolean> => {
      const p = payloadOf(t, s, o);
      const key = JSON.stringify(p);
      if (key === savedRef.current) return true;
      const err = questionError(t, s, p.options);
      if (err) return false;
      const id = await saveQuestion({ sessionId, questionId: qid, ...p });
      savedRef.current = key;
      if (!qid) {
        setQid(id);
        cb.current.onBound(id);
      }
      cb.current.onSaved();
      return true;
    },
    [payloadOf, qid, sessionId],
  );

  // 自动保存：600ms 防抖；不合法就只显示提示，不发请求
  useEffect(() => {
    if (readOnly) return;
    const p = payloadOf(qtype, stem, options);
    const key = JSON.stringify(p);
    if (key === savedRef.current) {
      setMsg('');
      return;
    }
    const err = questionError(qtype, stem, p.options);
    if (err) {
      setMsg(err);
      return;
    }
    setMsg('');
    let cancelled = false;
    // 上一次写入还没回来就再发一次，可能插出第二条（新建时 id 还没落地）——排队等它回来
    const run = async () => {
      if (savingRef.current) {
        window.setTimeout(() => { if (!cancelled && aliveRef.current) void run(); }, 300);
        return;
      }
      savingRef.current = true;
      if (aliveRef.current) setSaving(true);
      try {
        await flush(qtype, stem, options);
      } catch (e) {
        if (aliveRef.current) setMsg(simErrorMessage(e));
      } finally {
        savingRef.current = false;
        if (aliveRef.current) setSaving(false);
      }
    };
    const timer = window.setTimeout(() => { void run(); }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [qtype, stem, options, readOnly, payloadOf, flush]);

  const changeType = (t: SimQType) => {
    if (t === qtype) return;
    setQtype(t);
    setOptions((prev) => convertOptions(prev, t, scalePoints(prev)));
  };

  const setPointCount = (n: 3 | 5 | 7) => {
    setOptions((prev) => convertOptions(prev, 'scale', n));
  };

  const setLabel = (i: number, label: string) => {
    setOptions((prev) => prev.map((o, j) => (j === i ? { ...o, label } : o)));
  };

  const addOption = () => {
    if (options.length >= 6) return;
    const next = reseq([...options, { key: '', label: '' }], qtype);
    setOptions(next);
  };

  const removeOption = (i: number) => {
    if (options.length <= 2) return;
    setOptions(reseq(options.filter((_, j) => j !== i), qtype));
  };

  const applyPaste = () => {
    const lines = pasteText
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (lines.length < 2) {
      setMsg('至少粘贴 2 行选项');
      return;
    }
    setOptions(reseq(lines.map((label) => ({ key: '', label })), qtype));
    setPasteText('');
    setPasteOpen(false);
  };

  const head = (
    <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
      <span className="badge">{index + 1}</span>
      {readOnly ? (
        <span className="badge">{QTYPES.find((x) => x.value === qtype)?.label}</span>
      ) : (
        <select value={qtype} onChange={(e) => changeType(e.target.value as SimQType)} style={{ maxWidth: '8rem' }}>
          {QTYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      )}
      <span className="spacer" />
      {saving && <span className="muted" style={{ fontSize: '0.78rem' }}>保存中…</span>}
      {!readOnly && canEdit && (
        <div className="row" style={{ gap: '0.25rem' }}>
          <button className="ghost" onClick={() => onMove(-1, { id: qid, qtype, stem, options })} disabled={!canMoveUp} title="上移">↑</button>
          <button className="ghost" onClick={() => onMove(1, { id: qid, qtype, stem, options })} disabled={!canMoveDown} title="下移">↓</button>
          <button className="ghost" onClick={onDelete} style={{ color: 'var(--danger)' }}>删除</button>
        </div>
      )}
    </div>
  );

  if (readOnly) {
    return (
      <div className="card">
        {head}
        <SimQuestionView q={{ qtype, stem, options }} />
        {readOnlyNote && <p className="muted" style={{ fontSize: '0.8rem', margin: '0.4rem 0 0' }}>{readOnlyNote}</p>}
      </div>
    );
  }

  return (
    <div className="card">
      {head}
      <input
        value={stem}
        onChange={(e) => setStem(e.target.value)}
        placeholder="题干，例如：你平均每周花多少时间做家务？"
        maxLength={80}
        style={{ width: '100%', marginTop: '0.5rem' }}
      />

      {qtype === 'scale' ? (
        <div style={{ marginTop: '0.55rem' }}>
          <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 120 }}>
              <span className="muted" style={{ fontSize: '0.78rem' }}>左端文案</span>
              <input
                value={options[0]?.label ?? ''}
                onChange={(e) => setLabel(0, e.target.value)}
                placeholder="很不满意"
                maxLength={16}
                style={{ width: '100%' }}
              />
            </label>
            <label style={{ flex: 1, minWidth: 120 }}>
              <span className="muted" style={{ fontSize: '0.78rem' }}>右端文案</span>
              <input
                value={options[options.length - 1]?.label ?? ''}
                onChange={(e) => setLabel(options.length - 1, e.target.value)}
                placeholder="很满意"
                maxLength={16}
                style={{ width: '100%' }}
              />
            </label>
            <label>
              <span className="muted" style={{ fontSize: '0.78rem' }}>点数</span>
              <select
                value={options.length}
                onChange={(e) => setPointCount(Number(e.target.value) as 3 | 5 | 7)}
              >
                <option value={3}>3</option>
                <option value={5}>5</option>
                <option value={7}>7</option>
              </select>
            </label>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '0.35rem 0 0' }}>
            中间点是数字 {options.map((o) => o.key).join(' / ')}，不写字；学生看到的就是「{options[0]?.label || '左端'} … {options[options.length - 1]?.label || '右端'}」。
          </p>
        </div>
      ) : (
        <div style={{ marginTop: '0.55rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {options.map((o, i) => (
            <div key={o.key} className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
              <span className="badge">{o.key}</span>
              <input
                value={o.label}
                onChange={(e) => setLabel(i, e.target.value)}
                placeholder={`选项 ${o.key}`}
                maxLength={16}
                style={{ flex: 1, minWidth: 120 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (i === options.length - 1 && options.length < 6) addOption();
                  }
                  if (e.key === 'Backspace' && !o.label && options.length > 2) {
                    e.preventDefault();
                    removeOption(i);
                  }
                }}
              />
              <button className="ghost" onClick={() => removeOption(i)} disabled={options.length <= 2}>删除</button>
            </div>
          ))}
          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
            <button className="ghost" onClick={addOption} disabled={options.length >= 6}>+ 添加选项</button>
            <button className="ghost" onClick={() => setPasteOpen((v) => !v)}>批量粘贴</button>
          </div>
          {pasteOpen && (
            <div style={{ marginTop: '0.35rem' }}>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={'一行一个选项，最多 6 行\n例如：\n不到 2 小时\n2–5 小时\n超过 5 小时'}
                rows={4}
                style={{ width: '100%' }}
              />
              <div className="row" style={{ gap: '0.4rem' }}>
                <button className="primary" onClick={applyPaste}>替换选项</button>
                <button className="ghost" onClick={() => { setPasteOpen(false); setPasteText(''); }}>取消</button>
              </div>
            </div>
          )}
        </div>
      )}

      {msg && <p style={{ color: 'var(--danger)', fontSize: '0.82rem', margin: '0.45rem 0 0' }}>{msg}</p>}
      {!msg && <p className="muted" style={{ fontSize: '0.78rem', margin: '0.45rem 0 0' }}>自动保存，不用点提交</p>}
    </div>
  );
}
