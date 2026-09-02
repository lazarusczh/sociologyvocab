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
import Cloze from './components/Cloze';
import LogicChain from './components/LogicChain';

export type View =
  | 'home'
  | 'dictionary'
  | 'import'
  | 'quiz'
  | 'cloze'
  | 'flashcards'
  | 'chain'
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

// 导航：一级 pill + 二级下拉。单入口 pill 直跳，多入口 pill 展开二级菜单
// 2026-08-31 UI 改版：后台合并进右上角用户菜单、错题并入「练习」、
// 进度改由首页底部入口进入（首页卡片已含进度信息，导航不再单列）
interface NavItem { key: View; label: string; }
interface NavPill { group: string; items: NavItem[]; }

const NAV_PILLS: NavPill[] = [
  { group: '主页', items: [
    { key: 'home', label: '主页' },
  ]},
  { group: '测验/作业', items: [
    { key: 'quiz', label: '测验/作业' },
  ]},
  { group: '练习', items: [
    { key: 'choice', label: '选择题' },
    { key: 'chain', label: '接龙 Beta' },
    { key: 'cloze', label: '语境' },
    { key: 'spelling', label: '拼写' },
    { key: 'matching', label: '匹配' },
    { key: 'wrong', label: '错题' },
    { key: 'crossword', label: '纵横填字' },
    { key: 'wordle', label: 'Wordle' },
  ]},
  { group: '词典', items: [
    { key: 'dictionary', label: '词典' },
  ]},
  { group: '闪卡', items: [
    { key: 'flashcards', label: '闪卡' },
  ]},
  { group: '统计', items: [
    { key: 'data', label: '社会数据' },
  ]},
];

function AppBody() {
  const [view, setView] = useState<View>('home');
  const [menuOpen, setMenuOpen] = useState(false);
  // 手风琴：当前展开的分组；'account' 表示右上角用户菜单（与导航分组互斥）
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const { authUser, isTeacher, isDeveloper, skipped, inQuiz, exitSkip } = useStore();
  const viewRef = useRef(view);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
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
      if (navRef.current?.contains(t) || toggleRef.current?.contains(t) || accountRef.current?.contains(t)) return;
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
        {/* 品牌：书本形 mark + 名称（点击回首页） */}
        <span className="brand" onClick={() => goto('home')} style={{ cursor: 'pointer' }}>
          <span className="brand-mark" aria-hidden>📖</span>
          <span className="brand-text">社会学词汇</span>
        </span>

        <nav ref={navRef} className={menuOpen ? 'open' : ''}>
          {/* 窄屏：用户菜单并入汉堡顶部（桌面隐藏，改用右上角 account-chip） */}
          {(authUser || skipped) && (
            <div className="nav-account-mobile">
              <div className="nav-account-mobile__name">
                {authUser ? (authUser.name || authUser.email) : '离线游客'}
              </div>
              {authUser && (
                <button
                  className={view === 'profile' ? 'active' : ''}
                  onClick={() => goto('profile')}
                  disabled={inQuiz}
                >
                  个人中心
                </button>
              )}
              {authUser && isTeacher && (
                <button
                  className={view === 'import' ? 'active' : ''}
                  onClick={() => goto('import')}
                  disabled={inQuiz}
                >
                  教师后台
                </button>
              )}
              {authUser && isDeveloper && (
                <button
                  className={view === 'dev' ? 'active' : ''}
                  onClick={() => goto('dev')}
                  disabled={inQuiz}
                >
                  开发后台
                </button>
              )}
              {!authUser && skipped && (
                <>
                  <button
                    className={view === 'backup' ? 'active' : ''}
                    onClick={() => goto('backup')}
                    disabled={inQuiz}
                  >
                    本地备份
                  </button>
                  <button
                    onClick={() => { setMenuOpen(false); exitSkip(); }}
                    disabled={inQuiz}
                  >
                    注册 / 登录
                  </button>
                </>
              )}
            </div>
          )}
          {/* 一级 pill：单入口直跳，多入口展开二级下拉；语境题仅开发者（且非离线游客）可见 */}
          {NAV_PILLS.map((pill) => {
            const items = (isDeveloper && !skipped)
              ? pill.items
              : pill.items.filter((i) => i.key !== 'cloze');
            if (items.length === 0) return null;
            const groupActive = items.some((i) => view === i.key);
            const expanded = expandedGroup === pill.group;

            // 单入口：直接跳转
            if (items.length === 1) {
              const only = items[0];
              return (
                <button
                  key={pill.group}
                  className={`nav-pill${view === only.key ? ' active' : ''}`}
                  onClick={() => goto(only.key)}
                  disabled={inQuiz}
                >
                  {only.label}
                </button>
              );
            }

            // 多入口：展开二级菜单
            return (
              <div key={pill.group} className={`nav-group${groupActive ? ' has-active' : ''}`}>
                <button
                  className={`nav-group-head nav-pill${expanded ? ' expanded' : ''}${groupActive ? ' active' : ''}`}
                  onClick={() => setExpandedGroup(expanded ? null : pill.group)}
                  disabled={inQuiz}
                >
                  {pill.group}
                  <span className="nav-caret">{expanded ? '▾' : '▸'}</span>
                </button>
                {expanded && (
                  <div className="nav-group-items">
                    {items.map((item) => (
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
        </nav>

        <span className="spacer" />

        {/* 右上角用户区：已登录 → 个人中心/教师后台/开发后台；离线游客 → 本地备份/注册登录 */}
        {(authUser || skipped) && (
          <div className="nav-group account-menu" ref={accountRef}>
            <button
              className={`account-chip nav-pill${expandedGroup === 'account' ? ' expanded' : ''}`}
              onClick={() => setExpandedGroup(expandedGroup === 'account' ? null : 'account')}
              disabled={inQuiz}
              title={authUser ? `${authUser.email}（账号菜单）` : '离线游客（未登录）'}
            >
              {authUser ? (authUser.name || authUser.email) : '离线游客'}
              <span className="nav-caret">{expandedGroup === 'account' ? '▾' : '▸'}</span>
            </button>
            {expandedGroup === 'account' && (
              <div className="nav-group-items align-right">
                {authUser && (
                  <button
                    className={view === 'profile' ? 'active' : ''}
                    onClick={() => goto('profile')}
                    disabled={inQuiz}
                  >
                    个人中心
                  </button>
                )}
                {authUser && isTeacher && (
                  <button
                    className={view === 'import' ? 'active' : ''}
                    onClick={() => goto('import')}
                    disabled={inQuiz}
                  >
                    教师后台
                  </button>
                )}
                {authUser && isDeveloper && (
                  <button
                    className={view === 'dev' ? 'active' : ''}
                    onClick={() => goto('dev')}
                    disabled={inQuiz}
                  >
                    开发后台
                  </button>
                )}
                {!authUser && skipped && (
                  <>
                    <button
                      className={view === 'backup' ? 'active' : ''}
                      onClick={() => goto('backup')}
                      disabled={inQuiz}
                    >
                      本地备份
                    </button>
                    <button
                      onClick={() => { setExpandedGroup(null); exitSkip(); }}
                      disabled={inQuiz}
                    >
                      注册 / 登录
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
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
        {view === 'chain' && <LogicChain />}
        {view === 'choice' && <MultipleChoice />}
        {view === 'cloze' && isDeveloper && !skipped && <Cloze />}
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