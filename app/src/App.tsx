import { useState } from 'react';
import { StoreProvider } from './lib/store';
import Home from './components/Home';
import ImportPanel from './components/ImportPanel';
import Flashcards from './components/Flashcards';
import MultipleChoice from './components/MultipleChoice';
import Spelling from './components/Spelling';
import Matching from './components/Matching';
import Crossword from './components/Crossword';
import Wordle from './components/Wordle';
import ProgressView from './components/ProgressView';

export type View =
  | 'home'
  | 'import'
  | 'flashcards'
  | 'choice'
  | 'spelling'
  | 'matching'
  | 'crossword'
  | 'wordle'
  | 'progress';

const NAV: { key: View; label: string }[] = [
  { key: 'home', label: '首页' },
  { key: 'flashcards', label: '闪卡' },
  { key: 'choice', label: '选择题' },
  { key: 'spelling', label: '拼写' },
  { key: 'matching', label: '匹配' },
  { key: 'crossword', label: '纵横填字' },
  { key: 'wordle', label: 'Wordle' },
  { key: 'progress', label: '进度' },
];

function App() {
  const [view, setView] = useState<View>('home');

  return (
    <StoreProvider>
      <header className="topbar">
        <span className="brand" onClick={() => setView('home')} style={{ cursor: 'pointer' }}>
          社会学词汇练习
        </span>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.key}
              className={view === n.key ? 'active' : ''}
              onClick={() => setView(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="container">
        {view === 'home' && <Home go={setView} />}
        {view === 'import' && <ImportPanel />}
        {view === 'flashcards' && <Flashcards />}
        {view === 'choice' && <MultipleChoice />}
        {view === 'spelling' && <Spelling />}
        {view === 'matching' && <Matching />}
        {view === 'crossword' && <Crossword />}
        {view === 'wordle' && <Wordle />}
        {view === 'progress' && <ProgressView />}
      </main>
    </StoreProvider>
  );
}

export default App;
