// 教师端：按组挑题、润色、冻结班级问卷（阶段 grouped → frozen）
//
// 口径（见《模拟调研实装方案.md》第六节）：
//   · 一组一个选项卡，另加「全部（仅已选）」；相似只提示、不自动合并
//   · 教师改动只进班级问卷（items），不改学生草稿；改了置 edited_by_teacher
//   · 冻结由 RPC 校验：qid 必须真实存在于本场，题数 1..8
import { useMemo, useState } from 'react';
import {
  freezePaper,
  simErrorMessage,
  similarStem,
  type SimGroup,
  type SimOption,
  type SimParticipant,
  type SimPaperItem,
  type SimQuestion,
} from '../lib/sim';

const MAX_PICK = 6;

interface EditOverride {
  stem: string;
  options: SimOption[];
}

interface Props {
  sessionId: string;
  groups: SimGroup[];
  participants: SimParticipant[];
  questions: SimQuestion[];
  limit: number;
  onFrozen: (version: number) => void;
}

export default function SimMergePanel({ sessionId, groups, participants, questions, limit, onFrozen }: Props) {
  const [tab, setTab] = useState<string>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, EditOverride>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditOverride | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const byId = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);
  const groupNo = useMemo(() => new Map(groups.map((g) => [g.id, g.group_no])), [groups]);

  const effective = (q: SimQuestion): EditOverride => overrides[q.id] ?? { stem: q.stem, options: q.options };

  const toggle = (qid: string) => {
    setMsg('');
    setPicked((prev) => {
      if (prev.includes(qid)) return prev.filter((x) => x !== qid);
      if (prev.length >= MAX_PICK) {
        setMsg(`最多选 ${MAX_PICK} 题，先移出一题`);
        return prev;
      }
      return [...prev, qid];
    });
  };

  const beginEdit = (q: SimQuestion) => {
    setEditing(q.id);
    setDraft(effective(q));
    setMsg('');
  };

  const saveEdit = () => {
    if (!editing || !draft) return;
    const stem = draft.stem.trim();
    if (stem.length < 6) {
      setMsg('题干至少 6 个字');
      return;
    }
    const qtype = byId.get(editing)?.qtype;
    // 量表只要求两端有字（中间点是数字）；其余题型每个选项都不能留空
    const needLabels = qtype === 'scale'
      ? [draft.options[0], draft.options[draft.options.length - 1]]
      : draft.options;
    if (needLabels.some((o) => !o || !o.label.trim())) {
      setMsg(qtype === 'scale' ? '量表两端要写文案' : '选项不能留空');
      return;
    }
    setOverrides((prev) => ({ ...prev, [editing]: { stem, options: draft.options } }));
    setEditing(null);
    setDraft(null);
    setMsg('');
  };

  const handleFreeze = async () => {
    if (picked.length === 0) return;
    setBusy(true);
    setMsg('');
    try {
      const items: SimPaperItem[] = [];
      for (const qid of picked) {
        const q = byId.get(qid);
        if (!q) continue;
        const e = effective(q);
        items.push({
          qid: q.id,
          qtype: q.qtype,
          stem: e.stem,
          options: e.options,
          source_group: groupNo.get(q.group_id) ?? 0,
          edited_by_teacher: !!overrides[q.id],
        });
      }
      const version = await freezePaper(sessionId, items);
      onFrozen(version);
    } catch (e) {
      setMsg(simErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const similarTo = (q: SimQuestion): string => {
    for (const other of questions) {
      if (other.id === q.id || other.group_id === q.group_id) continue;
      if (similarStem(q.stem, other.stem)) return `与第 ${groupNo.get(other.group_id) ?? '?'} 组「${other.stem.slice(0, 12)}…」相近`;
    }
    return '';
  };

  const shown = tab === 'all' ? picked.map((id) => byId.get(id)).filter(Boolean) as SimQuestion[] : questions.filter((q) => q.group_id === tab);

  return (
    <>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>挑题合成班级问卷（已选 {picked.length}/{MAX_PICK}）</strong>
          <span className="spacer" />
          <button className="primary" onClick={handleFreeze} disabled={busy || picked.length === 0}>
            {busy ? '定稿中…' : '定稿这份问卷'}
          </button>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem', margin: '0.35rem 0 0' }}>
          定稿后学生草稿只读，接下来由三位受访者作答。改动只进班级问卷，不改学生草稿。
        </p>
        {msg && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '0.35rem 0 0' }}>{msg}</p>}

        <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
          <button className={tab === 'all' ? 'primary' : 'ghost'} onClick={() => setTab('all')}>
            全部（仅已选）
          </button>
          {groups.map((g) => {
            const n = picked.filter((id) => byId.get(id)?.group_id === g.id).length;
            const members = participants.filter((p) => p.group_id === g.id).length;
            return (
              <button key={g.id} className={tab === g.id ? 'primary' : 'ghost'} onClick={() => setTab(g.id)}>
                第 {g.group_no} 组 · {members} 人 · 已选 {n}
              </button>
            );
          })}
        </div>
      </div>

      {shown.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {tab === 'all' ? '还没选题。切到某一组的选项卡去挑。' : '这一组还没有题目。'}
          </p>
        </div>
      )}

      {shown.map((q) => {
        const e = effective(q);
        const isPicked = picked.includes(q.id);
        const hint = similarTo(q);
        const isEditing = editing === q.id;
        return (
          <div key={q.id} className="card" style={{ marginBottom: '0.8rem' }}>
            <div className="row" style={{ alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span className="badge">第 {groupNo.get(q.group_id) ?? '?'} 组</span>
              <span className="badge">{q.qtype === 'scale' ? '量表' : q.qtype === 'multi' ? '多选' : '单选'}</span>
              {overrides[q.id] && <span className="badge">已润色</span>}
              <span className="spacer" />
              <button className={isPicked ? 'ghost' : 'primary'} onClick={() => toggle(q.id)}>
                {isPicked ? '移出' : '选入'}
              </button>
              {!isEditing && <button className="ghost" onClick={() => beginEdit(q)}>改</button>}
            </div>

            {isEditing && draft ? (
              <div style={{ marginTop: '0.5rem' }}>
                <input
                  value={draft.stem}
                  onChange={(ev) => setDraft({ ...draft, stem: ev.target.value })}
                  style={{ width: '100%' }}
                  maxLength={80}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.4rem' }}>
                  {draft.options.map((o, i) => (
                    <div key={o.key} className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                      <span className="badge">{o.key}</span>
                      <input
                        value={o.label}
                        onChange={(ev) => {
                          const options = draft.options.map((x, j) => (j === i ? { ...x, label: ev.target.value } : x));
                          setDraft({ ...draft, options });
                        }}
                        style={{ flex: 1, minWidth: 120 }}
                        maxLength={16}
                      />
                    </div>
                  ))}
                </div>
                <div className="row" style={{ gap: '0.4rem', marginTop: '0.4rem' }}>
                  <button className="primary" onClick={saveEdit}>保存改动</button>
                  <button className="ghost" onClick={() => { setEditing(null); setDraft(null); }}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <p style={{ margin: '0.45rem 0 0.35rem', lineHeight: 1.55 }}>{e.stem}</p>
                <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                  {e.options.map((o) => (
                    <span key={o.key} className="muted" style={{ fontSize: '0.85rem' }}>
                      {o.key}. {o.label || '（空）'}
                    </span>
                  ))}
                </div>
              </>
            )}

            {hint && (
              <p className="muted" style={{ fontSize: '0.8rem', margin: '0.35rem 0 0' }}>
                相似提示：{hint}
              </p>
            )}
          </div>
        );
      })}

      <div className="card">
        <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>
          本场每组题数上限 {limit}。定稿后不能再改，答案会绑定这一版问卷（version），旧答案不会错位。
        </p>
      </div>
    </>
  );
}
