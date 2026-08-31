import { useState, useMemo, useCallback } from 'react';
import { useStore, useStudySession, useCelebrateCheckIn } from '../lib/store';
import { isInWrongBook } from '../lib/checkin';
import { maskAnswer } from '../lib/answers';
import { sample, shuffle } from '../lib/shuffle';
import type { VocabItem } from '../lib/types';

interface WQuestion {
  item: VocabItem;
  answer: string;
  options: string[];
}

const ROUND = 20;

function makeQuestion(item: VocabItem, pool: VocabItem[]): WQuestion {
  // 题干展示术语，选项为中文（缺少中文时退化为英文释义，并对释义脱敏）
  const maskedDef = (it: VocabItem) => maskAnswer(it, it.definition);
  const answer = item.chinese || maskedDef(item) || item.term;
  const distractors = pool
    .filter((p) => p.id !== item.id)
    .map((p) => p.chinese || maskedDef(p))
    .filter((t) => t && t !== answer)
    .filter((t, i, arr) => arr.indexOf(t) === i);
  const wrong = sample(distractors, 3);
  return { item, answer, options: shuffle([answer, ...wrong]) };
}

export default function WrongPractice() {
  const { vocab, wrongBook, recordItem } = useStore();

  // 错题本列表：累计答错≥2 且尚未连续答对满 3 次；按错题次数降序
  const wrongItems = useMemo(() => {
    const ids = Object.keys(wrongBook).filter((id) => isInWrongBook(wrongBook[id]));
    const items = ids
      .map((id) => vocab.find((v) => v.id === id))
      .filter((v): v is VocabItem => !!v);
    return items.sort((a, b) => (wrongBook[b.id]?.wrongCount ?? 0) - (wrongBook[a.id]?.wrongCount ?? 0));
  }, [vocab, wrongBook]);

  const [quiz, setQuiz] = useState<WQuestion[]>([]);
  const [qi, setQi] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  // 开始做题后才计时（筛选/准备阶段不计）
  useStudySession(quiz.length > 0);

  const start = useCallback(() => {
    const chosen = sample(wrongItems, Math.min(ROUND, wrongItems.length));
    setQuiz(chosen.map((it) => makeQuestion(it, vocab)));
    setQi(0);
    setPicked(null);
    setScore(0);
  }, [wrongItems, vocab]);

  const q = quiz[qi];

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

  useCelebrateCheckIn(quiz.length > 0 && !q);

  if (vocab.length === 0) {
    return <div className="empty-state"><div className="big">✖</div><p>请先导入词汇表</p></div>;
  }

  // 列表 / 空态
  if (quiz.length === 0) {
    return (
      <div>
        <h1>错题本</h1>
        <div className="card" style={{ marginBottom: '0.8rem' }}>
          <p className="muted">
            记录你在选择题、拼写默写、匹配题中答错的词汇。同一题累计答错 2 次进入错题本，
            连续答对 3 次后自动移出。
          </p>
          <button className="primary" onClick={start} disabled={wrongItems.length === 0}>
            {wrongItems.length > 0 ? `开始错题练习（${wrongItems.length} 题）` : '暂无错题'}
          </button>
        </div>

        {wrongItems.length === 0 ? (
          <div className="empty-state">
            <div className="big">🎉</div>
            <p>当前没有错题，继续保持！</p>
          </div>
        ) : (
          <div className="card">
            <h3>错题列表（{wrongItems.length}）</h3>
            <div className="grid" style={{ gap: '0.3rem' }}>
              {wrongItems.map((it) => (
                <div key={it.id} className="row" style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ flex: 1, minWidth: 160 }}>
                    <strong>{it.term}</strong>
                    {it.type === 'scholar' && <span className="badge" style={{ marginLeft: '0.4rem' }}>学者</span>}
                    {it.chinese && <span className="muted" style={{ marginLeft: '0.5rem', fontSize: '0.85rem' }}>{it.chinese}</span>}
                  </span>
                  <span className="badge danger">答错 {wrongBook[it.id]?.wrongCount ?? 0} 次</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // 答题完成
  if (!q) {
    return (
      <div className="card center">
        <h2>错题练习完成！</h2>
        <p className="muted">答对 {score} / {quiz.length} 题</p>
        <div className="row" style={{ justifyContent: 'center', marginTop: '0.5rem' }}>
          <button className="primary" onClick={start}>再来一轮</button>
          <button onClick={() => setQuiz([])}>返回错题列表</button>
        </div>
      </div>
    );
  }

  // 答题中
  return (
    <div>
      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <button className="ghost" onClick={() => setQuiz([])}>← 返回列表</button>
        <span className="spacer" />
        <span className="muted">第 {qi + 1} / {quiz.length} 题</span>
        <span className="badge success">答对 {score}</span>
      </div>

      <div className="card">
        <div className="muted" style={{ fontSize: '0.85rem' }}>根据术语选择对应释义</div>
        <h2 style={{ margin: '0.5rem 0 1rem' }}>{q.item.term}</h2>
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

      {picked && (
        <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
          <button className="primary" onClick={next}>
            {qi >= quiz.length - 1 ? '查看结果' : '下一题 →'}
          </button>
        </div>
      )}
    </div>
  );
}