import { useStore } from '../lib/store';
import type { View } from '../App';

interface Props {
  go: (v: View) => void;
}

const MODES: { key: View; icon: string; title: string; desc: string }[] = [
  { key: 'flashcards', icon: '🂠', title: '闪卡记忆', desc: '翻卡看释义，标记掌握程度' },
  { key: 'choice', icon: '☑', title: '选择题测验', desc: '四选一，术语与释义配对' },
  { key: 'spelling', icon: '✎', title: '拼写默写', desc: '看中文释义拼写英文术语' },
  { key: 'matching', icon: '⇄', title: '匹配题', desc: '术语与释义连线配对' },
  { key: 'crossword', icon: '⊞', title: '纵横填字', desc: '随机生成填字游戏' },
  { key: 'wordle', icon: '▤', title: 'Wordle', desc: '猜术语的字母游戏' },
];

export default function Home({ go }: Props) {
  const { vocab, progress, categories } = useStore();
  const learned = Object.values(progress).filter((p) => p.mastery >= 2).length;
  const total = vocab.length;
  const pct = total > 0 ? Math.round((learned / total) * 100) : 0;

  return (
    <div>
      {total === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="big">📚</div>
            <h2>欢迎使用社会学词汇练习</h2>
            <p className="muted">词库还是空的，请先导入 Excel 词汇表开始使用。</p>
            <button className="primary" onClick={() => go('import')} style={{ marginTop: '1rem' }}>
              导入词汇表
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: '0.8rem' }}>
            <h2>学习概览</h2>
            <div className="grid cols-3" style={{ marginTop: '0.5rem' }}>
              <div className="stat">
                <span className="num">{total}</span>
                <span className="label">词汇总数</span>
              </div>
              <div className="stat">
                <span className="num">{categories.length}</span>
                <span className="label">主题分类</span>
              </div>
              <div className="stat">
                <span className="num">{learned}</span>
                <span className="label">已掌握</span>
              </div>
            </div>
            <div style={{ marginTop: '0.8rem' }}>
              <div className="row" style={{ marginBottom: '0.3rem' }}>
                <span className="muted" style={{ fontSize: '0.85rem' }}>整体掌握度</span>
                <span className="spacer" />
                <span className="muted" style={{ fontSize: '0.85rem' }}>{pct}%</span>
              </div>
              <div className="progress-bar">
                <div style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>
        </>
      )}

      <h2 style={{ marginTop: '1.2rem' }}>选择练习模式</h2>
      <div className="grid cols-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            className="mode-card card"
            onClick={() => go(m.key)}
            disabled={total === 0}
          >
            <span className="icon">{m.icon}</span>
            <strong>{m.title}</strong>
            <span className="desc">{m.desc}</span>
          </button>
        ))}
      </div>

      <div className="row" style={{ marginTop: '1rem' }}>
        <button onClick={() => go('import')}>管理词库</button>
        <button onClick={() => go('progress')}>查看进度</button>
      </div>
    </div>
  );
}
