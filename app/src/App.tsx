import { useState, useEffect, useRef } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { StoreProvider, useStore } from './lib/store';
import IdentityGate from './components/IdentityGate';
import Home from './components/Home';
import Dictionary from './components/Dictionary';
import AdminPanel from './components/AdminPanel';
import BackupPanel from './components/BackupPanel';
import Flashcards from './components/Flashcards';
import MultipleChoice from './components/MultipleChoice';
import Spelling from './components/Spelling';
import Matching from './components/Matching';
import Crossword from './components/Crossword';
import Wordle from './components/Wordle';
import ProgressView from './components/ProgressView';
import WrongPractice from './components/WrongPractice';
import CheckInCelebration from './components/CheckInCelebration';
import ProfilePanel from './components/ProfilePanel';

export type View =
  | 'home'
  | 'dictionary'
  | 'import'
  | 'flashcards'
  | 'choice'
  | 'spelling'
  | 'matching'
  | 'crossword'
  | 'wordle'
  | 'wrong'
  | 'progress'
  | 'backup'
  | 'profile';

const NAV: { key: View; label: string }[] = [
  { key: 'home', label: '首页' },
  { key: 'dictionary', label: '词典' },
  { key: 'flashcards', label: '闪卡' },
  { key: 'choice', label: '选择题' },
  { key: 'spelling', label: '拼写' },
  { key: 'matching', label: '匹配' },
  { key: 'crossword', label: '纵横填字' },
  { key: 'wordle', label: 'Wordle' },
  { key: 'wrong', label: '错题' },
  { key: 'progress', label: '进度' },
];

function AppBody() {
  const [view, setView] = useState<View>('home');
  const [menuOpen, setMenuOpen] = useState(false);
  const { authUser, isTeacher, skipped } = useStore();
  const viewRef = useRef(view);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const goto = (next: View) => {
    setView(next);
    setMenuOpen(false);
  };

  // 同步最新 view 到 ref，供原生返回键回调读取
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // 菜单展开时，在菜单与汉堡按钮以外的区域按下（点击或拖动起始）即自动折叠
  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (navRef.current?.contains(t) || toggleRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [menuOpen]);

  // Android 硬件/手势返回键：非首页时先回首页，首页时退出应用
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: { remove: () => void } | null = null;
    let cancelled = false;
    CapacitorApp.addListener('backButton', () => {
      if (cancelled) return;
      if (viewRef.current !== 'home') {
        setView('home');
        setMenuOpen(false);
      } else {
        CapacitorApp.exitApp();
      }
    }).then((h) => {
      handle = h;
    });
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, []);

  return (
    <>
      <header className="topbar">
        <span className="brand" onClick={() => goto('home')} style={{ cursor: 'pointer' }}>
          社会学词汇练习
        </span>
        <nav ref={navRef} className={menuOpen ? 'open' : ''}>
          {NAV.map((n) => (
            <button
              key={n.key}
              className={view === n.key ? 'active' : ''}
              onClick={() => goto(n.key)}
            >
              {n.label}
            </button>
          ))}
          {skipped && (
            <button
              className={view === 'backup' ? 'active' : ''}
              onClick={() => goto('backup')}
            >
              备份
            </button>
          )}
        </nav>
        <span className="spacer" />
        {authUser && (
          <button
            className="account-chip"
            title={`${authUser.email}（进入个人账号）`}
            onClick={() => goto('profile')}
          >
            {authUser.name || authUser.email}
          </button>
        )}
        <button
          ref={toggleRef}
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
        {view !== 'home' && !Capacitor.isNativePlatform() && (
          <button className="back-btn" onClick={() => goto('home')}>
            ‹ 返回首页
          </button>
        )}
        {view === 'home' && <Home go={setView} />}
        {view === 'dictionary' && <Dictionary />}
        {view === 'import' && isTeacher && <AdminPanel />}
        {view === 'backup' && skipped && <BackupPanel />}
        {view === 'flashcards' && <Flashcards />}
        {view === 'choice' && <MultipleChoice />}
        {view === 'spelling' && <Spelling />}
        {view === 'matching' && <Matching />}
        {view === 'crossword' && <Crossword />}
        {view === 'wordle' && <Wordle />}
        {view === 'wrong' && <WrongPractice />}
        {view === 'progress' && <ProgressView />}
        {view === 'profile' && authUser && <ProfilePanel />}
      </main>
      <CheckInCelebration />
    </>
  );
}

function Shell() {
  const { authUser, skipped } = useStore();
  if (!authUser && !skipped) return <IdentityGate />;
  return <AppBody />;
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}