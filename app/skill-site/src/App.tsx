import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, getSession, fetchSkillData } from './supabase'
import type { Chapter, GlossaryEntry, Section, SkillData } from './data'
import AskView from './AskView'

type Status = 'loading' | 'guest' | 'ready' | 'error'

// 视图 = hash：''(目录) | #/chapter/<id> | #/glossary | #/patterns | #/cheatsheet | #/ask
const TABS = ['glossary', 'patterns', 'cheatsheet', 'ask'] as const;
type Tab = (typeof TABS)[number];

function parseHash(): { tab?: Tab; chapter?: string } {
  const h = window.location.hash;
  if (h.startsWith('#/chapter/')) return { chapter: h.slice('#/chapter/'.length) };
  const tab = h.slice(2) as Tab;
  return (TABS as readonly string[]).includes(tab) ? { tab } : {};
}

export default function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [skill, setSkill] = useState<SkillData | null>(null);
  const [route, setRoute] = useState(parseHash());
  const [menuOpen, setMenuOpen] = useState(false);

  // 1) 恢复主站共享的登录会话
  useEffect(() => {
    let alive = true;
    getSession().then(({ data }) => {
      if (!alive) return;
      const s = data.session;
      if (!s) { setStatus('guest'); return; }
      setSession(s);
      fetchSkillData()
        .then((d) => {
          if (!alive) return;
          if (d) { setSkill(d); setStatus('ready'); }
          else setStatus('error');
        })
        .catch(() => { if (alive) setStatus('error'); });
    });

    // 会话变化（另一标签页登录/登出）自动刷新
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, s) => {
      setSession(s);
      if (!s) { setSkill(null); setStatus('guest'); }
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  // 2) 监听 hash 变化
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (hash: string) => { window.location.hash = hash; };

  // 回主站：Web 回 9699vocab.cn，Capacitor 回本地主站 index.html（同源会话自动恢复登录）
  const goHome = () => { window.location.href = '/'; };

  if (status === 'loading') return <Centered>加载中…</Centered>;

  if (status === 'guest' || !session) {
    return (
      <Centered>
        <div className="gate">
          <h1>📚 教材知识库</h1>
          <p>该知识库含版权教材内容，仅对注册登录用户开放。</p>
          <button className="btn" onClick={() => { window.location.href = '/'; }}>前往登录</button>
        </div>
      </Centered>
    );
  }

  if (status === 'error' || !skill) {
    return (
      <Centered>
        <div className="gate">
          <h1>📚 教材知识库</h1>
          <p>内容加载失败或暂无内容，请稍后重试。</p>
          <button className="btn" onClick={() => window.location.reload()}>重试</button>
        </div>
      </Centered>
    );
  }

  const chapter =
    route.chapter ? skill.chapters.find((c) => c.id === route.chapter) : undefined;
  const tab = route.tab ?? '';

  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="layout">
      {/* 移动工具条：窄屏固定顶栏，汉堡展开章节抽屉 */}
      <div className="m-bar">
        <button className="m-burger" aria-label="菜单" onClick={() => setMenuOpen(!menuOpen)}>
          <span /><span /><span />
        </button>
        <div className="m-title" onClick={() => { go(''); closeMenu(); }} style={{ cursor: 'pointer' }}>
          📚 教材 AI
        </div>
        <button className="m-home" onClick={goHome} aria-label="返回词汇 App">
          <span className="m-home-long">← 返回词汇 App</span>
          <span className="m-home-short">← 返回</span>
        </button>
      </div>

      {/* 抽屉遮罩：窄屏展开时点外部关闭 */}
      <div className={`scrim${menuOpen ? ' show' : ''}`} onClick={closeMenu} />

      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="brand" onClick={() => { go(''); closeMenu(); }} style={{ cursor: 'pointer' }}>
          📚 知识库
        </div>
        <nav>
          <button className={`nav-ask${tab === 'ask' ? ' active' : ''}`} onClick={() => { go('/ask'); closeMenu(); }}>
            💬 AI 问答
          </button>
          <div className="nav-group-title">章节</div>
          {skill.chapters.map((c) => (
            <button key={c.id} className={chapter?.id === c.id ? 'active' : ''} onClick={() => { go(`/chapter/${c.id}`); closeMenu(); }}>
              {shortTitle(c.title)}
            </button>
          ))}
          <div className="nav-group-title">索引</div>
          <button className={tab === 'glossary' ? 'active' : ''} onClick={() => { go('/glossary'); closeMenu(); }}>
            术语表（{skill.glossary.length}）
          </button>
          <button className={tab === 'patterns' ? 'active' : ''} onClick={() => { go('/patterns'); closeMenu(); }}>
            答题模式（{skill.patterns.length}）
          </button>
          <button className={tab === 'cheatsheet' ? 'active' : ''} onClick={() => { go('/cheatsheet'); closeMenu(); }}>
            速查表
          </button>
        </nav>
        <div className="sidebar-foot">
          <button className="foot-btn back-home" onClick={goHome}>← 返回词汇 App</button>
          <div className="row">
            <span title={session.user.email}>{session.user.email}</span>
            <button className="foot-btn" onClick={() => void supabase.auth.signOut()}>退出</button>
          </div>
        </div>
      </aside>

      <main className={tab === 'ask' ? 'content ask-mode' : 'content'}>
        <header className="page-head">
          <h1>9699 社会学知识库</h1>
          <p className="desc">
            源自《Cambridge International AS &amp; A Level Sociology》蒸馏内容 · 仅供登录师生学习使用
            {skill.generated ? ` · 生成 ${skill.generated}` : ''}
          </p>
        </header>

        {!route.chapter && !route.tab && <ChapterList chapters={skill.chapters} />}

        {chapter && <ChapterView chapter={chapter} />}

        {tab === 'glossary' && <GlossaryView entries={skill.glossary} />}
        {tab === 'patterns' && <DocView title="答题模式与分析套路" sections={skill.patterns} />}
        {tab === 'cheatsheet' && <DocView title="决策速查" sections={skill.cheatsheet} />}
        {tab === 'ask' && <AskView skill={skill} />}
      </main>
    </div>
  );
}

function shortTitle(t: string) {
  return t.replace(/^Chapter\s*\d+\s*[:：]?\s*/, '');
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="center-wrap">{children}</div>;
}

function ChapterList({ chapters }: { chapters: Chapter[] }) {
  return (
    <ul className="chapter-list">
      {chapters.map((c) => (
        <li key={c.id}>
          <a href={`#/chapter/${c.id}`}>
            <span className="cl-title">{c.title}</span>
            {c.tagline && <span className="cl-tag">{c.tagline}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

function ChapterView({ chapter }: { chapter: Chapter }) {
  return (
    <article className="chapter">
      <h2>{chapter.title}</h2>
      {chapter.sections.map((s, i) => (
        <SectionView key={i} section={s} />
      ))}
    </article>
  );
}

function SectionView({ section }: { section: Section }) {
  if (!section.lines.length) return null;
  return (
    <section className="doc-sec">
      {section.heading && <h3>{section.heading}</h3>}
      <div>
        {section.lines.map((ln, i) =>
          ln.startsWith('• ') ? (
            <li key={i} className="li">{ln.slice(2)}</li>
          ) : (
            <p key={i}>{ln}</p>
          ),
        )}
      </div>
    </section>
  );
}

function GlossaryView({ entries }: { entries: GlossaryEntry[] }) {
  const [q, setQ] = useState('');
  const t = q.trim().toLowerCase();
  const list = t
    ? entries.filter((g) => (g.term + ' ' + g.zh + ' ' + g.def).toLowerCase().includes(t))
    : entries;
  return (
    <section className="glossary">
      <h2>术语表</h2>
      <input className="search" placeholder="搜索术语（中英皆可）…" value={q} onChange={(e) => setQ(e.target.value)} />
      <p className="hint">{list.length} / {entries.length} 条</p>
      {list.map((g) => (
        <div className="gloss-item" key={g.term}>
          <strong>{g.term}</strong>
          {g.chapters.length > 0 && (
            <span className="chaps">{g.chapters.map((c) => c.replace(/^ch/, 'Ch ')).join('、')}</span>
          )}
          <p>{g.def}</p>
        </div>
      ))}
      {list.length === 0 && <p className="empty">无匹配结果。</p>}
    </section>
  );
}

function DocView({ title, sections }: { title: string; sections: Section[] }) {
  return (
    <article className="chapter">
      <h2>{title}</h2>
      {sections.map((s, i) => (
        <SectionView key={i} section={s} />
      ))}
    </article>
  );
}
