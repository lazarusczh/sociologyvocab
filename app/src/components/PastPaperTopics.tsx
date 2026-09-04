import { useEffect, useMemo, useState } from 'react';

// 数据由 app/scripts/generate-pastpaper-topics.mjs 从切题 md 生成（含 Specimen，作资料展示；与组卷器题库互相独立）
export interface PptItem {
  src: string;          // 如 S26 QP11 Q3 / Specimen 2
  marks: string;        // '' 或 4 / 10+6 / 12 / 26
  statement: string;    // 观点陈述（引号内），'' 表示该行无 statement
  instruction: string;  // 题干的其余指令部分
  note: string;         // md 行尾备注（（media）/ ⚠… /（兼属…））
}
export interface PptTopic {
  title: string;
  level: number;
  count: number;
  items: PptItem[];
  children: PptTopic[];
}
export interface PptPaper {
  label: string;
  file: string;
  title: string;
  total: number;
  topics: PptTopic[];
}
export interface PptData {
  papers: PptPaper[];
}

function topicCount(t: PptTopic): number {
  return t.items.length + t.children.reduce((s, c) => s + topicCount(c), 0);
}
function collectKeys(topics: PptTopic[], prefix = ''): string[] {
  const out: string[] = [];
  topics.forEach((t, i) => {
    const k = prefix ? `${prefix}.${i}` : String(i);
    out.push(k, ...collectKeys(t.children, k));
  });
  return out;
}

function ItemCard({ it }: { it: PptItem }) {
  return (
    <div className="ppt-item">
      <div className="ppt-item-meta">
        <span className="ppt-tag">{it.src}</span>
        {it.marks && <span className="ppt-tag ppt-tag-marks">{it.marks} 分</span>}
        {it.note && <span className="ppt-note">{it.note}</span>}
      </div>
      {it.statement && <p className="ppt-stmt">{it.statement}</p>}
      {it.instruction && (
        <p className={it.statement ? 'ppt-instr' : 'ppt-instr ppt-instr-primary'}>{it.instruction}</p>
      )}
    </div>
  );
}

export default function PastPaperTopics() {
  const [data, setData] = useState<PptData | null>(null);
  const [failed, setFailed] = useState(false);
  const [pi, setPi] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    fetch('/pastpaper-topics.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PptData | null) => {
        if (!cancelled) {
          if (d?.papers?.length) setData(d);
          else setFailed(true);
        }
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const paper = data?.papers[pi];
  const allKeys = useMemo(() => (paper ? collectKeys(paper.topics) : []), [paper]);

  // 切卷时重置为全部折叠（默认折叠，点击展开）
  useEffect(() => { setOpen({}); }, [pi]);

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const expandAll = () => setOpen(Object.fromEntries(allKeys.map((k) => [k, true])));
  const collapseAll = () => setOpen({});

  const fold = (t: PptTopic, k: string, depth: number) => {
    const isOpen = !!open[k];
    const head = depth === 0 ? 'ppt-root-head' : 'ppt-fold-head';
    return (
      <div className="ppt-fold" key={k}>
        <button
          type="button"
          className={head}
          style={{ paddingLeft: 12 + depth * 14 }}
          aria-expanded={isOpen}
          onClick={() => toggle(k)}
        >
          <span className={isOpen ? 'ppt-caret open' : 'ppt-caret'}>▸</span>
          <span className="ppt-fold-title">{t.title}</span>
          <span className="ppt-count">{topicCount(t)}</span>
        </button>
        {isOpen && (t.items.length > 0 || t.children.length > 0) && (
          <div className="ppt-fold-body">
            {t.items.map((it, i) => (
              <ItemCard key={`i${i}`} it={it} />
            ))}
            {t.children.map((c, i) => fold(c, `${k}.${i}`, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (failed) return <div className="ppt-state">历年真题数据未加载成功，请稍后重试。</div>;
  if (!data || !paper) return <div className="ppt-state">正在加载历年真题…</div>;

  return (
    <>
      <div className="ppt-tabs">
        {data.papers.map((p, i) => (
          <button
            key={p.file}
            type="button"
            className={i === pi ? 'ppt-tab active' : 'ppt-tab'}
            onClick={() => setPi(i)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="ppt-toolbar">
        <span className="ppt-meta">{paper.title} · 共 {paper.total} 题</span>
        <span className="ppt-actions">
          <button type="button" className="ppt-link" onClick={expandAll}>全部展开</button>
          <button type="button" className="ppt-link" onClick={collapseAll}>全部收起</button>
        </span>
      </div>
      <div className="ppt-list">
        {paper.topics.map((t, i) => fold(t, String(i), 0))}
      </div>
    </>
  );
}
