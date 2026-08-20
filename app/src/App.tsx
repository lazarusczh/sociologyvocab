import { useState } from 'react';
import { StoreProvider, useStore } from './lib/store';
import IdentityGate from './components/IdentityGate';
import Home from './components/Home';
import ImportPanel from './components/ImportPanel';
import BackupPanel from './components/BackupPanel';
import Flashcards from './components/Flashcards';
import MultipleChoice from './components/MultipleChoice';
import Spelling from './components/Spelling';
import Matching from './components/Matching';
import Crossword from './components/Crossword';
import Wordle from './components/Wordle';
import ProgressView from './components/ProgressView';
import WrongPractice from './components/WrongPractice';

export type View =
  | 'home'
  | 'import'
  | 'flashcards'
  | 'choice'
  | 'spelling'
  | 'matching'
  | 'crossword'
  | 'wordle'
  | 'wrong'
  | 'progress'
  | 'backup';

const NAV: { key: View; label: string }[] = [
  { key: 'home', label: '首页' },
  { key: 'flashcards', label: '闪卡' },
  { key: 'choice', label: '选择题' },
  { key: 'spelling', label: '拼写' },
  { key: 'matching', label: '匹配' },
  { key: 'crossword', label: '纵横填字' },
  { key: 'wordle', label: 'Wordle' },
  { key: 'wrong', label: '错题' },
  { key: 'progress', label: '进度' },
  { key: 'backup', label: '备份' },
];

function AppBody() {
  const [view, setView] = useState<View>('home');
  const [menuOpen, setMenuOpen] = useState(false);

  const goto = (next: View) => {
    setView(next);
    setMenuOpen(false);
  };

  return (
    <>
      <header className="topbar">
        <span className="brand" onClick={() => goto('home')} style={{ cursor: 'pointer' }}>
          社会学词汇练习
        </span>
        <nav className={menuOpen ? 'open' : ''}>
          {NAV.map((n) => (
            <button
              key={n.key}
              className={view === n.key ? 'active' : ''}
              onClick={() => goto(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button
          className="nav-toggle"
          aria-label="菜单"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
      </header>
      <main className="container">
        {view === 'home' && <Home go={setView} />}
        {view === 'import' && <ImportPanel />}
        {view === 'backup' && <BackupPanel />}
        {view === 'flashcards' && <Flashcards />}
        {view === 'choice' && <MultipleChoice />}
        {view === 'spelling' && <Spelling />}
        {view === 'matching' && <Matching />}
        {view === 'crossword' && <Crossword />}
        {view === 'wordle' && <Wordle />}
        {view === 'wrong' && <WrongPractice />}
        {view === 'progress' && <ProgressView />}
      </main>
    </>
  );
}

function Shell() {
  const { identity, skipped } = useStore();
  if (!identity && !skipped) return <IdentityGate />;
  return <AppBody />;
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}