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
import ConceptMapView from './components/ConceptMapView';
import PastPaperTopics from './components/PastPaperTopics';

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
  | 'conceptmap'
  | 'papers'
  | 'backup'
  | 'profile'
  | 'dev';

// 导航：一级 pill + 二级下拉。单入口 pill 直跳，多入口 pill 展开二级菜单
// 2026-08-31 UI 改版：后台合并进右上角用户菜单、错题并入「练习」、
// 进度改由首页底部入口进入（首页卡片已含进度信息，导航不再单列）
interface NavItem { key: View | 'skill'; label: string; href?: string; authOnly?: boolean; }
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
    { key: 'cloze', label: '语境 Beta' },
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
  { group: '资料', items: [
    { key: 'papers', label: '历年真题' },
    { key: 'data', label: '社会数据' },
    { key: 'conceptmap', label: '概念网络' },
    { key: 'skill', label: '教材 AI', href: '/skill/#/ask', authOnly: true },
  ]},
];

function AppBody() {
  const [view, setView] = useState<View>('home');
  const [menuOpen, setMenuOpen] = useState(false);
  // 手风琴：当前展开的分组；'account' 表示右上角用户菜单（与导航分组互斥）
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  // 窄屏二级面板进出场：expandedGroup 是目标值，panelGroup 是实际渲染值（退场时延迟卸载）
  const [panelGroup, setPanelGroup] = useState<string | null>(null);
  const [panelExiting, setPanelExiting] = useState(false);
  const { authUser, isTeacher, isDeveloper, skipped, inQuiz, exitSkip } = useStore();
  const viewRef = useRef(view);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const inQuizRef = useRef(inQuiz);
  // 窄屏汉堡面板内各分组容器：展开后自动滚入视野，避免子项落在浏览器底栏外
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    inQuizRef.current = inQuiz;
  }, [inQuiz]);

  const goto = (next: View) => {
    if (inQuizRef.current && next !== 'quiz') return; // 考试中锁导航
    setView(next);
    setMenuOpen(false);
  };

  // 打开导航项：href 外链整页跳转；否则视为 view 切换
  const openNav = (item: { key: string; label: string; href?: string }) => {
    if (inQuizRef.current) return;
    if (item.href) {
      // 拆出 hash（如 /skill/#/ask），Capacitor 原生环境需落在显式文件后：
      // 浏览器 → /skill/#/ask；APK → /skill/index.html#/ask
      const [path, hash] = item.href.split('#');
      const target = Capacitor.isNativePlatform() && path.endsWith('/')
        ? `${path}index.html${hash ? `#${hash}` : ''}`
        : item.href;
      window.location.href = target;
      return;
    }
    goto(item.key as View);
  };

  // 同步最新 view 到 ref，供原生返回键回调读取
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // 展开分组后：把该分组（连同刚展开的二级项）滚入视野，落到底部的分组也能立刻看到子项
  useEffect(() => {
    if (!expandedGroup || expandedGroup === 'account') return;
    const el = groupRefs.current[expandedGroup];
    if (!el) return;
    // 等展开动画（240ms）走完再滚动，否则按折叠高度计算会滚不到位
    const id = window.setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 260);
    return () => window.clearTimeout(id);
  }, [expandedGroup]);

  // 窄屏二级面板：目标分组驱动进出场动画。
  // 进入 → 立即渲染子面板播放滑入；返回 → 先播放滑出，动画结束（180ms）后再卸载。
  const mobileGroup = expandedGroup && expandedGroup !== 'account' ? expandedGroup : null;
  const firstPanelRun = useRef(true);
  useEffect(() => {
    if (firstPanelRun.current) {
      firstPanelRun.current = false;
      if (!mobileGroup) return;
    }
    if (mobileGroup) {
      setPanelExiting(false);
      setPanelGroup(mobileGroup);
      return;
    }
    setPanelExiting(true);
    const id = window.setTimeout(() => {
      setPanelGroup(null);
      setPanelExiting(false);
    }, 180);
    return () => window.clearTimeout(id);
  }, [mobileGroup]);

  // 菜单整体关闭（选中项跳转 / 点外部）时立即收掉二级面板，避免下次打开残留
  useEffect(() => {
    if (!menuOpen) {
      setPanelGroup(null);
      setPanelExiting(false);
    }
  }, [menuOpen]);

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

  // 移动浏览器底栏会动态占用视口，100dvh 在某些 WebView 仍被遮挡；
  // 用 visualViewport 实时把可用高度写入 --vv-height，CSS 据此计算菜单最大高度。
  useEffect(() => {
    const root = document.documentElement;
    const setVv = () => {
      const vv = window.visualViewport;
      const h = vv ? vv.height : window.innerHeight;
      root.style.setProperty('--vv-height', `${h}px`);
    };
    setVv();
    window.visualViewport?.addEventListener('resize', setVv);
    window.addEventListener('resize', setVv);
    return () => {
      window.visualViewport?.removeEventListener('resize', setVv);
      window.removeEventListener('resize', setVv);
    };
  }, []);

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

          {/* 窄屏 drill-down 菜单（桌面隐藏）：点击分组后从右侧滑出子项面板，隐藏其他一级菜单；
              返回时先播放反向滑出（子面板右移淡出 + 一级列表从左侧回位），动画结束再卸载 */}
          <div className="nav-mobile">
            {panelGroup ? (
              <div className={`nav-mobile-submenu${panelExiting ? ' is-exiting' : ''}`}>
                <button
                  className="nav-mobile-back"
                  onClick={() => setExpandedGroup(null)}
                  disabled={inQuiz}
                >
                  <span className="nav-mobile-back__caret">‹</span>
                  {panelGroup}
                </button>
                <div className="nav-mobile-submenu-items">
                  {NAV_PILLS.find((p) => p.group === panelGroup)?.items
                    .filter((i) => !i.authOnly || !!authUser)
                    .map((item) => (
                      <button
                        key={item.key}
                        className={view === item.key ? 'active' : ''}
                        onClick={() => {
                          setExpandedGroup(null);
                          openNav(item);
                        }}
                        disabled={inQuiz}
                      >
                        {item.label}
                      </button>
                    ))}
                </div>
              </div>
            ) : null}
            {!panelGroup || panelExiting ? (
              <div className={`nav-mobile-top${panelExiting ? ' is-restoring' : ''}`}>
                {NAV_PILLS.map((pill) => {
                  const items = pill.items.filter((i) => !i.authOnly || !!authUser);
                  if (items.length === 0) return null;
                  if (items.length === 1) {
                    const only = items[0];
                    return (
                      <button
                        key={pill.group}
                        className={`nav-mobile-item${!only.href && view === only.key ? ' active' : ''}`}
                        onClick={() => openNav(only)}
                        disabled={inQuiz}
                      >
                        {only.label}
                      </button>
                    );
                  }
                  const groupActive = items.some((i) => view === i.key);
                  return (
                    <button
                      key={pill.group}
                      className={`nav-mobile-item nav-mobile-item--group${groupActive ? ' active' : ''}`}
                      onClick={() => setExpandedGroup(pill.group)}
                      disabled={inQuiz}
                    >
                      {pill.group}
                      <span className="nav-caret">▸</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          {/* 桌面 pill 导航（窄屏隐藏）：单入口直跳，多入口下拉 */}
          <div className="nav-desktop">
            {NAV_PILLS.map((pill) => {
              // authOnly 项仅对已登录用户展示（如「教材知识库」含版权内容）
              const items = pill.items.filter((i) => !i.authOnly || !!authUser);
              if (items.length === 0) return null;
              const groupActive = items.some((i) => view === i.key);
              const expanded = expandedGroup === pill.group;

              // 单入口：直接跳转（href 外链项整页跳转；否则 view 切换）
              if (items.length === 1) {
                const only = items[0];
                return (
                  <button
                    key={pill.group}
                    className={`nav-pill${!only.href && view === only.key ? ' active' : ''}`}
                    onClick={() => openNav(only)}
                    disabled={inQuiz}
                  >
                    {only.label}
                  </button>
                );
              }

              // 多入口：展开二级下拉
              return (
                <div
                  key={pill.group}
                  className={`nav-group${groupActive ? ' has-active' : ''}${expanded ? ' is-open' : ''}`}
                  ref={(el) => { groupRefs.current[pill.group] = el; }}
                >
                  <button
                    className={`nav-group-head nav-pill${expanded ? ' expanded' : ''}${groupActive ? ' active' : ''}`}
                    onClick={() => setExpandedGroup(expanded ? null : pill.group)}
                    disabled={inQuiz}
                  >
                    {pill.group}
                    <span className="nav-caret">{expanded ? '▾' : '▸'}</span>
                  </button>
                  <div
                    className={`nav-group-items${expanded ? ' is-expanded' : ''}`}
                    inert={!expanded}
                  >
                    <div className="nav-group-items__inner">
                      {items.map((item) => (
                        <button
                          key={item.key}
                          className={view === item.key ? 'active' : ''}
                          onClick={() => {
                            setExpandedGroup(null);
                            openNav(item);
                          }}
                          disabled={inQuiz}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
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
        {view === 'cloze' && <Cloze />}
        {view === 'spelling' && <Spelling />}
        {view === 'matching' && <Matching />}
        {view === 'crossword' && <Crossword />}
        {view === 'wordle' && <Wordle />}
        {view === 'wrong' && <WrongPractice />}
        {view === 'progress' && <ProgressView />}
        {view === 'data' && <DataBoard />}
        {view === 'conceptmap' && <ConceptMapView />}
        {view === 'papers' && <PastPaperTopics />}
        {view === 'profile' && authUser && <ProfilePanel />}
        {view === 'dev' && isDeveloper && <DevPanel />}
      </main>
      <CheckInCelebration />
      <VersionCheck />
    </>
  );
}

function Shell() {
  const { authUser, skipped, authReady } = useStore();
  // 会话尚未判定完成时先显示加载态：直接渲染 IdentityGate 会让"正在恢复登录"看起来像被登出
  //（在需要走同源代理回退的设备上这段等待明显更长，误判尤其刺眼）
  if (!authReady) return <BootScreen />;
  if (!authUser && !skipped) return <IdentityGate />;
  return <AppBody />;
}

// 启动加载态：会话恢复期间替代登录页显示，避免"掉登录"的错觉。
// 超过 1.2s 才追加第二行说明，避免快路径（本机会话）也闪一段解释文字。
function BootScreen() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 1200);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="gate">
      <div className="card gate-card boot-screen">
        <span className="boot-spinner" />
        <h1>正在加载</h1>
        <p className="muted">
          {slow
            ? '网络较慢或正在切换备用通道，登录状态仍在校验中，请稍候（不必刷新）。'
            : '正在恢复登录状态…'}
        </p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}