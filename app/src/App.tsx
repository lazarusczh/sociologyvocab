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
import DataBoard from './components/DataBoard';
import CheckInCelebration from './components/CheckInCelebration';
import VersionCheck from './components/VersionCheck';
import ProfilePanel from './components/ProfilePanel';
import DevPanel from './components/DevPanel';
import QuizTaker from './components/QuizTaker';

export type View =
  | 'home'
  | 'dictionary'
  | 'import'
  | 'quiz'
  | 'flashcards'
  | 'choice'
  | 'spelling'
  | 'matching'
  | 'crossword'
  | 'wordle'
  | 'wrong'
  | 'progress'
  | 'data'
  | 'backup'
  | 'profile'
  | 'dev';

// 导航：分组结构（练习/趣味/后台为可展开分组，其余为单入口）
interface NavItem { key: View; label: string; }
interface NavGroup { group: string; items: NavItem[]; }

const NAV_TOP: NavItem[] = [
  { key: 'home', label: '首页' },
  { key: 'dictionary', label: '词典' },
  { key: 'flashcards', label: '闪卡' },
];

const NAV_GROUPS: NavGroup[] = [
  { group: '练习', items: [
    { key: 'choice', label: '选择题' },
    { key: 'spelling', label: '拼写' },
    { key: 'matching', label: '匹配' },
  ]},
  { group: '趣味', items: [
    { key: 'crossword', label: '纵横填字' },
    { key: 'wordle', label: 'Wordle' },
  ]},
];

const NAV_BOTTOM: NavItem[] = [
  { key: 'wrong', label: '错题' },
  { key: 'progress', label: '进度' },
  { key: 'data', label: '社会数据' },
];

function AppBody() {
  const [view, setView] = useState<View>('home');
  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null); // 手风琴：当前展开的分组
  const { authUser, isTeacher, isDeveloper, skipped, inQuiz } = useStore();
  const viewRef = useRef(view);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inQuizRef = useRef(inQuiz);

  useEffect(() => {
    inQuizRef.current = inQuiz;
  }, [inQuiz]);

  const goto = (next: View) => {
    if (inQuizRef.current && next !== 'quiz') return; // 考试中锁导航
    setView(next);
    setMenuOpen(false);
  };

  // 同步最新 view 到 ref，供原生返回键回调读取
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // 汉堡菜单或二级分组任一展开时，在导航与汉堡按钮以外的区域按下（点击或拖动起始）即自动收回
  useEffect(() => {
    if (!menuOpen && !expandedGroup) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (navRef.current?.contains(t) || toggleRef.current?.contains(t)) return;
      setMenuOpen(false);
      setExpandedGroup(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [menuOpen, expandedGroup]);

  // Android 硬件/手势返回键：非首页时先回首页，首页时退出应用
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: { remove: () => void } | null = null;
    let cancelled = false;
    CapacitorApp.addListener('backButton', () => {
      if (cancelled) return;
      if (inQuizRef.current) return; // 考试中拦截返回键
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
          {/* 顶部单入口：首页/词典/闪卡 */}
          {NAV_TOP.map((n) => (
            <button
              key={n.key}
              className={view === n.key ? 'active' : ''}
              onClick={() => goto(n.key)}
              disabled={inQuiz}
            >
              {n.label}
            </button>
          ))}

          {/* 分组：练习 / 趣味（手风琴展开） */}
          {NAV_GROUPS.map((g) => {
            const expanded = expandedGroup === g.group;
            const groupActive = g.items.some((i) => view === i.key);
            return (
              <div key={g.group} className="nav-group">
                <button
                  className={`nav-group-head${expanded ? ' expanded' : ''}${groupActive ? ' has-active' : ''}`}
                  onClick={() => setExpandedGroup(expanded ? null : g.group)}
                  disabled={inQuiz}
                >
                  {g.group}
                  <span className="nav-caret">{expanded ? '▾' : '▸'}</span>
                </button>
                {expanded && (
                  <div className="nav-group-items">
                    {g.items.map((item) => (
                      <button
                        key={item.key}
                        className={view === item.key ? 'active' : ''}
                        onClick={() => goto(item.key)}
                        disabled={inQuiz}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* 底部单入口：错题/进度/社会数据 */}
          {NAV_BOTTOM.map((n) => (
            <button
              key={n.key}
              className={view === n.key ? 'active' : ''}
              onClick={() => goto(n.key)}
              disabled={inQuiz}
            >
              {n.label}
            </button>
          ))}

          {/* 随堂测验 */}
          <button
            className={view === 'quiz' ? 'active' : ''}
            onClick={() => goto('quiz')}
            disabled={inQuiz}
          >
            随堂测验
          </button>

          {/* 后台分组（仅教师/开发可见） */}
          {(isTeacher || isDeveloper) && (
            <div key="admin" className="nav-group">
              <button
                className={`nav-group-head${expandedGroup === '后台' ? ' expanded' : ''}${view === 'import' || view === 'dev' ? ' has-active' : ''}`}
                onClick={() => setExpandedGroup(expandedGroup === '后台' ? null : '后台')}
                disabled={inQuiz}
              >
                后台
                <span className="nav-caret">{expandedGroup === '后台' ? '▾' : '▸'}</span>
              </button>
              {expandedGroup === '后台' && (
                <div className="nav-group-items">
                  {isTeacher && (
                    <button
                      className={view === 'import' ? 'active' : ''}
                      onClick={() => goto('import')}
                      disabled={inQuiz}
                    >
                      教师后台
                    </button>
                  )}
                  {isDeveloper && (
                    <button
                      className={view === 'dev' ? 'active' : ''}
                      onClick={() => goto('dev')}
                      disabled={inQuiz}
                    >
                      开发
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 备份（仅离线游客） */}
          {skipped && (
            <button
              className={view === 'backup' ? 'active' : ''}
              onClick={() => goto('backup')}
              disabled={inQuiz}
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
            disabled={inQuiz}
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
        {view !== 'home' && !Capacitor.isNativePlatform() && !inQuiz && (
          <button className="back-btn" onClick={() => goto('home')}>
            ‹ 返回首页
          </button>
        )}
        {view === 'home' && <Home go={setView} />}
        {view === 'dictionary' && <Dictionary />}
        {view === 'import' && isTeacher && <AdminPanel />}
        {view === 'quiz' && <QuizTaker />}
        {view === 'backup' && skipped && <BackupPanel />}
        {view === 'flashcards' && <Flashcards />}
        {view === 'choice' && <MultipleChoice />}
        {view === 'spelling' && <Spelling />}
        {view === 'matching' && <Matching />}
        {view === 'crossword' && <Crossword />}
        {view === 'wordle' && <Wordle />}
        {view === 'wrong' && <WrongPractice />}
        {view === 'progress' && <ProgressView />}
        {view === 'data' && <DataBoard />}
        {view === 'profile' && authUser && <ProfilePanel />}
        {view === 'dev' && isDeveloper && <DevPanel />}
      </main>
      <CheckInCelebration />
      <VersionCheck />
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