import { useState, useMemo, useCallback } from 'react';
import { useStore, useStudySession, useCelebrateCheckIn } from '../lib/store';
import { shuffle, sample } from '../lib/shuffle';
import { maskAnswer } from '../lib/answers';
import CategoryFilter, { filterByPaperCat } from './CategoryFilter';
import type { VocabItem } from '../lib/types';

interface Question {
  item: VocabItem;
  prompt: string;      // 题干文本
  promptLabel: string; // 题干标签：术语/释义/中文
  answer: string;      // 正确答案文本
  options: string[];   // 4个选项（含正确答案）
}

const QUESTION_COUNT = 10;

function buildQuestion(item: VocabItem, pool: VocabItem[]): Question {
  // 随机决定方向：给术语选释义 / 给释义选术语 / 给中文选术语
  const dirs: ('term2def' | 'def2term' | 'cn2term')[] = ['term2def', 'def2term'];
  if (item.chinese) dirs.push('cn2term');
  const dir = dirs[Math.floor(Math.random() * dirs.length)];

  let prompt: string, answer: string, promptLabel: string, optionSource: 'term' | 'def';
  const maskedDef = (it: VocabItem) => maskAnswer(it, it.definition);
  if (dir === 'term2def') {
    prompt = item.term;
    answer = maskedDef(item);
    promptLabel = '术语';
    optionSource = 'def';
  } else if (dir === 'def2term') {
    prompt = maskedDef(item);
    answer = item.term;
    promptLabel = '释义';
    optionSource = 'term';
  } else {
    prompt = item.chinese;
    answer = item.term;
    promptLabel = '中文';
    optionSource = 'term';
  }

  // 取干扰项：同一类型（学者用名字作选项，术语视情况）
  const distractors = pool
    .filter((p) => p.id !== item.id)
    .map((p) => (optionSource === 'term' ? p.term : maskedDef(p)))
    .filter((t) => t && t !== answer)
    .filter((t, i, arr) => arr.indexOf(t) === i);

  const wrong = sample(distractors, 3);
  const options = shuffle([answer, ...wrong]);
  return { item, prompt, promptLabel, answer, options };
}

export default function MultipleChoice() {
  const { vocab, recordItem, papers, categories } = useStore();
  const [paper, setPaper] = useState('all');
  const [cat, setCat] = useState('all');
  const [unit, setUnit] = useState('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'term' | 'scholar'>('all');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [qi, setQi] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  // 开始做题后才计时（筛选/准备阶段不计）
  useStudySession(questions.length > 0);

  const onPaperChange = (p: string) => {
    setPaper(p);
    setCat('all');
    setUnit('all');
  };

  const onCatChange = (c: string) => {
    setCat(c);
    setUnit('all');
  };

  const filtered = useMemo(
    () => filterByPaperCat(vocab, paper, cat, unit).filter((i) => typeFilter === 'all' || i.type === typeFilter),
    [vocab, paper, cat, unit, typeFilter],
  );

  const start = useCallback(() => {
    const pool = filtered.filter((i) => i.definition && i.term);
    if (pool.length < 4) return;
    const chosen = sample(pool, Math.min(QUESTION_COUNT, pool.length));
    setQuestions(chosen.map((item) => buildQuestion(item, pool)));
    setQi(0);
    setPicked(null);
    setScore(0);
  }, [filtered]);

  const q = questions[qi];

  const pick = (opt: string) => {
    if (picked) return;
    setPicked(opt);
    const correct = opt === q.answer;
    if (correct) setScore((s) => s + 1);
    recordItem(q.item.id, correct, 'choice');
  };

  const next = () => {
    setQi((i) => i + 1);
    setPicked(null);
  };

  useCelebrateCheckIn(questions.length > 0 && !q);

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">☑</div><p>请先导入词汇表</p></div>;
  }

  if (questions.length === 0) {
    return (
      <div>
        <h1>选择题测验</h1>
        <CategoryFilter
          items={vocab}
          papers={papers}
          categories={categories}
          paper={paper}
          onPaperChange={onPaperChange}
          cat={cat}
          onCatChange={onCatChange}
          unit={unit}
          onUnitChange={setUnit}
          typeFilter={typeFilter}
          onTypeChange={setTypeFilter}
        />
        <div className="card">
          <p>每轮 {QUESTION_COUNT} 题，四选一。方向随机（术语↔释义↔中文）。</p>
          <button className="primary" onClick={start} disabled={filtered.length < 4}>
            {filtered.length < 4 ? '至少需要 4 条词汇' : '开始测验'}
          </button>
        </div>
      </div>
    );
  }

  if (!q) {
    return (
      <div className="card center">
        <h2>测验完成！</h2>
        <p className="muted">得分：{score} / {questions.length}</p>
        <div className="progress-bar" style={{ maxWidth: 300, margin: '1rem auto' }}>
          <div style={{ width: `${(score / questions.length) * 100}%` }} />
        </div>
        <button className="primary" onClick={start}>再来一轮</button>
      </div>
    );
  }

  return (
    <div>
      <div className="mc-topbar">
        <button className="mc-back" onClick={() => setQuestions([])}>← 返回</button>
        <span className="mc-progress" aria-hidden>
          <span className="mc-progress-fill" style={{ width: `${(qi / questions.length) * 100}%` }} />
        </span>
        <span className="mc-meta">第 {qi + 1} / {questions.length} 题 · 答对 {score}</span>
      </div>

      <div className="mc-prompt card">
        <div className="muted" style={{ fontSize: '0.85rem' }}>根据{q.promptLabel}选择正确答案</div>
        <h1 className="mc-term">{q.prompt}</h1>
        <div className="grid" style={{ gap: '0.5rem' }}>
          {q.options.map((opt) => {
            const isCorrect = opt === q.answer;
            const isPicked = opt === picked;
            let cls = 'option-btn';
            if (picked) {
              if (isCorrect) cls += ' correct';
              else if (isPicked) cls += ' wrong';
            }
            return (
              <button key={opt} className={cls} onClick={() => pick(opt)} disabled={!!picked}>
                <span className={`mark ${picked && isCorrect ? 'correct' : picked && isPicked ? 'wrong' : ''}`}>
                  {String.fromCharCode(65 + q.options.indexOf(opt))}
                </span>
                <span>{opt}</span>
              </button>
            );
          })}
        </div>
      </div>

      {picked && (() => {
        const correct = picked === q.answer;
        return (
          <div className="mc-explain">
            <div className={`mc-verdict ${correct ? 'ok' : 'no'}`}>
              {correct ? '✓ 答对了' : '✗ 答错了'}
            </div>
            <div className="mc-explain-term">
              <strong>{q.item.term}</strong>
              {q.item.chinese && <span className="mc-explain-cn"> · {q.item.chinese}</span>}
            </div>
            <div className="mc-explain-def">{q.item.definition}</div>
            <div className="row" style={{ marginTop: '0.9rem', justifyContent: 'flex-end' }}>
              <button className="primary" onClick={next}>
                {qi >= questions.length - 1 ? '查看结果' : '下一题 →'}
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
