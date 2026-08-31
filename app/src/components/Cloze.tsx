import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore, useStudySession, useCelebrateCheckIn } from '../lib/store';
import { normalizeKey, isCorrectAnswer, getAcceptableKeys } from '../lib/answers';
import { sample, shuffle } from '../lib/shuffle';
import type { VocabItem } from '../lib/types';

// 语境题：内置题库（cloze-data.json，{{术语}} 标记挖空）。形态：拼写填空 / 选词填空
interface ClozePassage {
  id: string;
  title: string;   // 主题标签
  category: string; // Paper 标签
  text: string;     // 英文题干，含 {{术语}} 挖空
}

interface Blank {
  term: string;          // 挖空词（词库 term / 别名）
  item: VocabItem | null; // 匹配到的词库词条；null → 精确比较兜底
}

interface RoundItem {
  passage: ClozePassage;
  blanks: Blank[];
  inputs: string[];              // 拼写模式：每空输入
  results: boolean[];            // 每空判分
  options?: string[][];          // 选词模式：每空选项
  selected?: (string | null)[];  // 选词模式：每空选中
}

type Mode = 'spelling' | 'choice';

const ROUND_SIZE = 10;
const BLANK_RE = /\{\{([^}]+)\}\}/g;

// 把挖空词匹配到词库词条（术语按可接受写法，学者按姓氏/别名）
function matchItem(vocab: VocabItem[], term: string): VocabItem | null {
  const key = normalizeKey(term);
  return vocab.find((it) => getAcceptableKeys(it).includes(key)) ?? null;
}

// 题干片段：普通文本 / 挖空
function parseText(text: string): { text: string; blank?: string }[] {
  const parts: { text: string; blank?: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = /\{\{([^}]+)\}\}/g;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: '', blank: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// 判分（拼写模式）：优先复用词库容错；词库无对应词条时精确比较兜底
function checkBlank(blank: Blank, input: string): boolean {
  const v = (input || '').trim();
  if (!v) return false;
  return blank.item ? isCorrectAnswer(blank.item, v) : normalizeKey(v) === normalizeKey(blank.term);
}

// 填空提示下划线：按词组单词数分段（几个词几段），每段下划线数≈该词字母数，视觉上与框宽匹配
function blankPlaceholder(term: string): string {
  const words = (term || '').trim().split(/\s+/).filter(Boolean);
  return words.map((w) => '_'.repeat(w.length)).join(' ');
}

// 选词填空：生成一个空的选项（1 正确 + 3 迷惑项）
// 抽选原则（按优先级）：① 同类型（术语配术语、学者配学者，不混类）
//   ② 同 Paper 且同主题（unit 有交集） ③ 同 Paper 但不同主题 ④ 跨 Paper 兜底
// 排除答案本身（含 normalize 等价）
function buildOptions(blank: Blank, category: string, vocab: VocabItem[]): string[] {
  const answerKey = normalizeKey(blank.term);
  const type = blank.item?.type;
  const units = new Set(blank.item?.unit ?? []);
  const sameType = (i: VocabItem) => !type || i.type === type;
  const notAnswer = (t: string) => !!t && normalizeKey(t) !== answerKey;
  const uniq = (arr: string[]) => arr.filter((t, i) => arr.indexOf(t) === i);
  const sharesUnit = (i: VocabItem) => units.size === 0 || (i.unit ?? []).some((u) => units.has(u));

  const samePaper = vocab.filter(sameType).filter((i) => (i.paper || '').includes(category));
  const sameUnit = uniq(samePaper.filter(sharesUnit).map((i) => i.term).filter(notAnswer));
  const samePaperOther = uniq(samePaper.filter((i) => !sharesUnit(i)).map((i) => i.term).filter(notAnswer));
  const rest = uniq(
    vocab
      .filter(sameType)
      .filter((i) => !(i.paper || '').includes(category))
      .map((i) => i.term)
      .filter((t) => notAnswer(t) && !sameUnit.includes(t) && !samePaperOther.includes(t)),
  );

  const wrong: string[] = [];
  const take = (pool: string[], need: number) => {
    const got = sample(pool, Math.min(need, pool.length));
    wrong.push(...got);
    return need - got.length;
  };
  let need = 3;
  need = take(sameUnit, need);        // 同 Paper 同主题
  if (need > 0) need = take(samePaperOther, need); // 同 Paper 异主题
  if (need > 0) need = take(rest, need);           // 跨 Paper
  return shuffle([blank.term, ...wrong]);
}

export default function Cloze() {
  const { vocab, recordItem } = useStore();
  useStudySession();
  const [passages, setPassages] = useState<ClozePassage[]>([]);
  const [paper, setPaper] = useState('all');
  const [mode, setMode] = useState<Mode>('spelling');
  const [round, setRound] = useState<RoundItem[]>([]);
  const [qi, setQi] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [score, setScore] = useState(0);

  // 加载内置语境题库
  useEffect(() => {
    let cancelled = false;
    fetch('/cloze-data.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ClozePassage[]) => {
        if (!cancelled) setPassages(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const papers = useMemo(() => [...new Set(passages.map((p) => p.category))], [passages]);

  const filtered = useMemo(
    () => passages.filter((p) => paper === 'all' || p.category === paper),
    [passages, paper],
  );

  const start = useCallback(() => {
    if (!filtered.length) return;
    const chosen = sample(filtered, Math.min(ROUND_SIZE, filtered.length));
    setRound(
      chosen.map((p) => {
        const blanks = [...p.text.matchAll(BLANK_RE)].map((m) => ({
          term: m[1],
          item: matchItem(vocab, m[1]),
        }));
        const base = { passage: p, blanks, inputs: blanks.map(() => ''), results: [] };
        if (mode === 'choice') {
          return {
            ...base,
            options: blanks.map((b) => buildOptions(b, p.category, vocab)),
            selected: blanks.map(() => null),
          };
        }
        return base;
      }),
    );
    setQi(0);
    setRevealed(false);
    setScore(0);
  }, [filtered, vocab, mode]);

  const current = round[qi];
  const finished = round.length > 0 && qi >= round.length;

  const updateInput = (bi: number, value: string) => {
    setRound((prev) =>
      prev.map((it, idx) => (idx === qi ? { ...it, inputs: it.inputs.map((v, j) => (j === bi ? value : v)) } : it)),
    );
  };

  const updateSelected = (bi: number, val: string) => {
    setRound((prev) =>
      prev.map((it, idx) => (idx === qi ? { ...it, selected: it.selected!.map((v, j) => (j === bi ? val : v)) } : it)),
    );
  };

  // 判分：逐空判定，记录到掌握度/错题本；按挖空数量计分（对几个得几分）
  const submit = () => {
    if (!current) return;
    const results = current.blanks.map((b, i) =>
      mode === 'choice'
        ? normalizeKey(current.selected?.[i] ?? '') === normalizeKey(b.term)
        : checkBlank(b, current.inputs[i]),
    );
    setRound((prev) => prev.map((it, idx) => (idx === qi ? { ...it, results } : it)));
    setRevealed(true);
    results.forEach((ok, i) => {
      const item = current.blanks[i].item;
      if (item) recordItem(item.id, ok, 'cloze');
    });
    setScore((s) => s + results.filter(Boolean).length);
  };

  const next = () => {
    setQi((i) => i + 1);
    setRevealed(false);
  };

  useCelebrateCheckIn(finished);

  if (passages.length === 0) {
    return <div className="empty-state"><div className="big">📝</div><p>语境题库加载中…</p></div>;
  }

  if (round.length === 0) {
    return (
      <div>
        <h1>语境题</h1>
        <p className="muted">根据语境补全术语（来源：历年纸质作业语境填空题 + 高分答卷段落）。</p>
        <div className="card" style={{ marginBottom: '0.6rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>按试卷筛选：</span>
          <select value={paper} onChange={(e) => setPaper(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="all">全部</option>
            {papers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="card">
          <div className="row" style={{ gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button className={mode === 'spelling' ? 'primary' : 'ghost'} onClick={() => setMode('spelling')}>拼写填空</button>
            <button className={mode === 'choice' ? 'primary' : 'ghost'} onClick={() => setMode('choice')}>选词填空</button>
          </div>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            {mode === 'spelling' ? '根据语境打字输入术语（较难）。' : '根据语境从选项中选出术语（更简单）。'}
          </p>
          <button className="primary" onClick={start} disabled={!filtered.length}>
            {filtered.length ? `开始（题库 ${filtered.length} 题）` : '该分类暂无题目'}
          </button>
        </div>
      </div>
    );
  }

  if (finished) {
    const totalBlanks = round.reduce((n, r) => n + r.blanks.length, 0);
    return (
      <div className="card center">
        <h2>完成！</h2>
        <p className="muted">得分：{score} / {totalBlanks}（挖空数）</p>
        <div className="progress-bar" style={{ maxWidth: 300, margin: '1rem auto' }}>
          <div style={{ width: `${totalBlanks ? (score / totalBlanks) * 100 : 0}%` }} />
        </div>
        <button className="primary" onClick={start}>再来一轮</button>
        <button className="ghost" onClick={() => setRound([])} style={{ marginLeft: '0.5rem' }}>返回</button>
      </div>
    );
  }

  // 渲染题干：普通文本 + 挖空（拼写=输入框 / 选词=选项组）
  const rendered = (() => {
    let bi = -1;
    return parseText(current.passage.text).map((part, pi) => {
      if (!part.blank) return <span key={pi}>{part.text}</span>;
      bi += 1;
      const idx = bi;
      if (mode === 'choice') {
        const picked = current.selected?.[idx];
        return (
          <span key={pi} className="cloze-gap">
            {picked || blankPlaceholder(part.blank)}
          </span>
        );
      }
      return (
        <input
          key={pi}
          autoFocus={idx === 0}
          value={current.inputs[idx] ?? ''}
          onChange={(e) => updateInput(idx, e.target.value)}
          disabled={revealed}
          placeholder={blankPlaceholder(part.blank)}
          style={{ width: Math.max(90, blankPlaceholder(part.blank).length * 9 + 14), textAlign: 'center', margin: '0 0.15rem' }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !revealed) submit(); }}
        />
      );
    });
  })();

  const canSubmit = mode === 'choice'
    ? (current.selected ?? []).some((v) => !v)
    : current.inputs.some((v) => !v.trim());

  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button className="ghost" onClick={() => setRound([])}>← 返回</button>
        <span className="spacer" />
        <span className="muted">第 {qi + 1} / {round.length} 题 · 得分 {score}</span>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: '0.4rem' }}>
          <span className="badge">{current.passage.category}</span>
          <span className="muted" style={{ fontSize: '0.85rem' }}>{current.passage.title}</span>
        </div>

        <p style={{ fontSize: '1.05rem', lineHeight: 2.1, margin: '0.4rem 0 1rem' }}>{rendered}</p>

        {mode === 'choice' && (
          <div style={{ margin: '0.2rem 0 0.8rem' }}>
            {current.blanks.map((b, i) => {
              const opts = current.options?.[i] ?? [];
              const picked = current.selected?.[i];
              return (
                <div key={i} className="row" style={{ gap: '0.5rem', margin: '0.35rem 0', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: '0.85rem' }}>第 {i + 1} 空</span>
                  {opts.map((opt) => {
                    const isAns = normalizeKey(opt) === normalizeKey(b.term);
                    const isPicked = picked === opt;
                    let cls = 'cloze-opt';
                    if (revealed) {
                      if (isAns) cls += ' correct';
                      else if (isPicked) cls += ' wrong';
                    }
                    return (
                      <button key={opt} className={cls} disabled={revealed} onClick={() => updateSelected(i, opt)}>
                        {opt}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {revealed && (
          <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.4rem' }}>
            {current.blanks.map((b, i) => {
              const ok = current.results[i];
              const you = mode === 'choice' ? current.selected?.[i] : current.inputs[i];
              return (
                <span key={i} className={`badge ${ok ? 'success' : ''}`}>
                  {ok ? '✓ ' : '✗ '}{b.term}（你{mode === 'choice' ? '选' : '填'}：{you || '—'}）
                </span>
              );
            })}
          </div>
        )}

        <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          {!revealed ? (
            <button className="primary" onClick={submit} disabled={canSubmit}>
              提交
            </button>
          ) : (
            <button className="primary" onClick={next}>
              {qi >= round.length - 1 ? '查看结果' : '下一题 →'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
