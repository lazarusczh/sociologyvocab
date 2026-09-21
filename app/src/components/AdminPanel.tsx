import { useCallback, useEffect, useState } from 'react';
import ImportPanel from './ImportPanel';
import TeacherCheckPanel from './TeacherCheckPanel';
import DefinitionReviewPanel from './DefinitionReviewPanel';
import VocabManager from './VocabManager';
import LogicManager from './LogicManager';
import ClassManager from './ClassManager';
import QuizManager from './QuizManager';
import Grouper from './Grouper';
import PaperResults from './PaperResults';
import AiGatePanel from './AiGatePanel';
import OcrMarkPanel from './OcrMarkPanel';

// 教师后台（仅教师版显示）。导航两种形态，按视口宽度自动切换：
//   · 宽屏（≥1100px）：**左侧栏**（组名当分区标题、页平铺列出）—— 与多数站点后台一致；
//   · 窄屏（<1100px）：顶部**两级药丸**（一级分组 + 二级组内页，均为单行可横滑）。
//   两种形态共用同一份 GROUPS 定义与同一份位置记忆，切换宽度时不会丢当前位置。
// 侧栏会占掉约 190px：内容区从 920 降到 ≈700px，正文/表单没问题，宽表格本来就有横向滚动；
//   「OCR 阅卷」原先的"原图与文字并排"因此改为「查看原图」按钮 + 覆盖层（2026-09-15 教师决定）。
// 位置记忆：localStorage 记住「上次所在的组」与「每组上次所在的页」；记忆失效时回退到该组第一项。

type TabKey =
  | 'check' | 'classes' | 'quiz' | 'grouper' | 'results' | 'defreview'
  | 'aigate' | 'ocr' | 'vocab' | 'logic' | 'import';

type GroupKey = 'task' | 'student' | 'content';

interface TabDef { key: TabKey; label: string }
interface GroupDef { key: GroupKey; label: string; tabs: TabDef[] }

const GROUPS: GroupDef[] = [
  {
    key: 'task',
    label: '任务管理',
    tabs: [
      { key: 'quiz', label: '测验/作业' },   // 最高频，放首位
      { key: 'grouper', label: '组卷器' },   // 组卷 → 阅卷 → 登分，保持这个顺序
      { key: 'ocr', label: 'OCR 阅卷' },
      { key: 'defreview', label: '定义题复核' },   // 与 OCR 阅卷同类：看学生真实作答并判定
      { key: 'results', label: '试卷成绩' },
    ],
  },
  {
    key: 'student',
    label: '学生管理',
    tabs: [
      { key: 'check', label: '打卡核验' },
      { key: 'classes', label: '班级管理' },
      { key: 'aigate', label: 'AI 门禁' },
    ],
  },
  {
    key: 'content',
    label: '内容管理',
    tabs: [
      { key: 'vocab', label: '词条管理' },
      { key: 'logic', label: '逻辑管理' },
      { key: 'import', label: '批量导入' },
    ],
  },
];

const DEFAULT_GROUP: GroupKey = 'task';
const STORE_KEY = 'socio_vocab_admin_nav';
const WIDE_QUERY = '(min-width: 1100px)';

// 每页一句话说明（宽屏下也保留，放在内容顶部）
const PAGE_HINT: Record<TabKey, string> = {
  quiz: '创建随堂测验/作业，看待答与成绩（ManageBac 同步也在这里）。',
  grouper: '按考卷与考点组一份卷；保存后到「试卷成绩」登记分数。',
  ocr: '上传纸质答卷照片，视觉模型转写并在原文里高亮术语与学者。',
  defreview: '复核学生在定义题练习里的真实作答与模型判分，给出教师判定并统计一致率。',
  results: '回访已保存的试卷、登记卷面分并换算百分制，可同步 ManageBac。',
  check: '查看打卡与掌握度统计，可按班级筛选。',
  classes: '建立班级、给学生分班，并绑定 ManageBac 成绩册与导入名单。',
  aigate: '暂停或放行学生的 AI 问答（教师与开发者始终放行）。',
  vocab: '维护词条、释义与可接受答案；编辑后需发布才同步给学生。',
  logic: '维护词条间的逻辑关系（上下位 / 并列 / 相反）与图谱。',
  import: '批量导入词条 xlsx，并发布新版本到云端。',
};

const groupOf = (t: TabKey): GroupKey =>
  GROUPS.find((g) => g.tabs.some((x) => x.key === t))?.key ?? DEFAULT_GROUP;

interface NavMemory { group: GroupKey; last: Partial<Record<GroupKey, TabKey>> }

function loadMemory(): NavMemory {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const m = JSON.parse(raw) as Partial<NavMemory>;
      const group = GROUPS.some((g) => g.key === m.group) ? (m.group as GroupKey) : DEFAULT_GROUP;
      return { group, last: (m.last ?? {}) as Partial<Record<GroupKey, TabKey>> };
    }
  } catch {
    /* 解析失败/无 localStorage：用默认 */
  }
  return { group: DEFAULT_GROUP, last: {} };
}

function saveMemory(m: NavMemory): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(m));
  } catch {
    /* 忽略 */
  }
}

/** 宽屏判定（侧栏 / 顶部两级）。用 matchMedia，缩放窗口时两种形态自动切换且不丢位置。 */
function useWideNav(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(WIDE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

export default function AdminPanel() {
  const wide = useWideNav();
  const [nav, setNav] = useState<NavMemory>(() => loadMemory());

  const group = GROUPS.find((g) => g.key === nav.group) ?? GROUPS[0];
  const remembered = nav.last[group.key];
  const tab: TabKey = group.tabs.some((t) => t.key === remembered) ? (remembered as TabKey) : group.tabs[0].key;

  // 切页面：同时记住它所在的组
  const goTab = useCallback((next: TabKey) => {
    const g = groupOf(next);
    setNav((prev) => {
      const m: NavMemory = { group: g, last: { ...prev.last, [g]: next } };
      saveMemory(m);
      return m;
    });
  }, []);

  // 切组：组内页面沿用该组上次所在页（没有则第一项）
  const goGroup = (g: GroupKey) => {
    setNav((prev) => {
      const m: NavMemory = { group: g, last: prev.last };
      saveMemory(m);
      return m;
    });
  };

  const content = (
    <>
      {tab === 'check' && <TeacherCheckPanel />}
      {tab === 'classes' && <ClassManager />}
      {tab === 'quiz' && <QuizManager />}
      {tab === 'grouper' && <Grouper onOpenResults={() => goTab('results')} />}
      {tab === 'results' && <PaperResults />}
      {tab === 'aigate' && <AiGatePanel />}
      {tab === 'ocr' && <OcrMarkPanel />}
      {tab === 'defreview' && <DefinitionReviewPanel />}
      {tab === 'vocab' && <VocabManager />}
      {tab === 'logic' && <LogicManager />}
      {tab === 'import' && <ImportPanel />}
    </>
  );

  const hint = (
    <p className="muted" style={{ margin: '0 0 0.9rem', fontSize: '0.85rem', maxWidth: '46rem' }}>
      {PAGE_HINT[tab]}
    </p>
  );

  return (
    <div>
      {/* 标题。不放面包屑（2026-09-15 教师决定）：宽屏由侧栏表明位置；窄屏两级药丸都在屏幕上
          且各自有选中态，面包屑只会是重复信息。 */}
      <h1 style={{ margin: '0 0 0.9rem' }}>教师后台</h1>

      {wide ? (
        /* ============ 宽屏：左侧栏（与多数站点后台一致） ============ */
        <div className="admin-shell">
          <aside className="admin-side">
            {GROUPS.map((g) => (
              <div key={g.key}>
                <div className={'admin-side__group' + (g.key === group.key ? ' on' : '')}>{g.label}</div>
                {g.tabs.map((t) => (
                  <button
                    key={t.key}
                    className={'admin-side__page' + (t.key === tab ? ' active' : '')}
                    onClick={() => goTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            ))}
          </aside>
          <section className="admin-main">
            {hint}
            {content}
          </section>
        </div>
      ) : (
        /* ============ 窄屏：顶部两级药丸（一级分组 + 二级组内页，单行可横滑） ============ */
        <>
          <div className="tag-filter" style={{ flexWrap: 'nowrap', overflowX: 'auto' }}>
            {GROUPS.map((g) => (
              <button
                key={g.key}
                className={g.key === group.key ? 'active' : ''}
                style={{ fontSize: '0.85rem', fontWeight: 600 }}
                onClick={() => goGroup(g.key)}
              >
                {g.label}
              </button>
            ))}
          </div>

          <div className="admin-nav-divider" />

          <div className="tag-filter admin-subnav" style={{ marginBottom: '0.35rem', flexWrap: 'nowrap', overflowX: 'auto' }}>
            {group.tabs.map((t) => (
              <button key={t.key} className={t.key === tab ? 'active' : ''} onClick={() => goTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          {hint}
          {content}
        </>
      )}
    </div>
  );
}
