import type { VocabItem } from '../lib/types';
import { unitListFor } from '../lib/unitMapping';

// 依据考卷 + 次级标签 + 单元筛选（'all' 时不过滤对应层级）
export function filterByPaperCat(items: VocabItem[], paper: string, cat: string, unit = 'all'): VocabItem[] {
  return items.filter(
    (i) =>
      (paper === 'all' || i.paper === paper) &&
      (cat === 'all' || i.category === cat) &&
      (unit === 'all' || (i.unit ?? []).includes(unit)),
  );
}

interface Props {
  items: VocabItem[];
  papers: string[];         // 考卷大类（Paper 1-4）
  categories: string[];     // 次级标签（非空）
  paper: string;            // 选中考卷：'all' 或 'Paper N'
  onPaperChange: (p: string) => void;
  cat: string;              // 选中次级标签：'all' 或次级标签名
  onCatChange: (c: string) => void;
  unit?: string;            // 选中单元：'all' 或单元名
  onUnitChange?: (u: string) => void;
  typeFilter?: 'all' | 'term' | 'scholar';
  onTypeChange?: (t: 'all' | 'term' | 'scholar') => void;
}

export default function CategoryFilter({
  items,
  papers,
  categories,
  paper,
  onPaperChange,
  cat,
  onCatChange,
  unit = 'all',
  onUnitChange,
  typeFilter = 'all',
  onTypeChange,
}: Props) {
  const typeOk = (i: VocabItem) => typeFilter === 'all' || i.type === typeFilter;

  const paperCount = (p: string) =>
    items.filter((i) => (p === 'all' || i.paper === p) && typeOk(i)).length;

  // 当前考卷下的次级标签；仅当该卷有多个次级标签时展示（如 Paper 4 的 Globalisation/Media）
  const subLabels =
    paper === 'all'
      ? []
      : categories.filter((c) => items.some((i) => i.paper === paper && i.category === c));

  const units = unitListFor(items, paper, cat);
  const unitCount = (u: string) =>
    items.filter(
      (i) => i.paper === paper && (cat === 'all' || i.category === cat) && (i.unit ?? []).includes(u) && typeOk(i),
    ).length;

  const shown = paperCount(paper);

  return (
    <div className="card" style={{ marginBottom: '0.8rem' }}>
      {onTypeChange && (
        <div className="row tight" style={{ marginBottom: '0.5rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>类型：</span>
          {(['all', 'term', 'scholar'] as const).map((t) => (
            <button
              key={t}
              className={typeFilter === t ? 'active' : ''}
              style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}
              onClick={() => onTypeChange(t)}
            >
              {t === 'all' ? '全部' : t === 'term' ? '术语' : '学者'}
            </button>
          ))}
          <span className="spacer" />
          <span className="muted" style={{ fontSize: '0.85rem' }}>共 {shown} 条</span>
        </div>
      )}
      <div className="tag-filter">
        <button className={paper === 'all' ? 'active' : ''} onClick={() => onPaperChange('all')}>
          全部考卷
        </button>
        {papers.map((p) => (
          <button key={p} className={paper === p ? 'active' : ''} onClick={() => onPaperChange(p)}>
            {p} ({paperCount(p)})
          </button>
        ))}
      </div>
      {subLabels.length > 1 && (
        <div className="tag-filter" style={{ marginTop: '0.4rem' }}>
          <button className={cat === 'all' ? 'active' : ''} onClick={() => onCatChange('all')}>
            全部主题
          </button>
          {subLabels.map((c) => (
            <button key={c} className={cat === c ? 'active' : ''} onClick={() => onCatChange(c)}>
              {c} ({items.filter((i) => i.paper === paper && i.category === c && typeOk(i)).length})
            </button>
          ))}
        </div>
      )}
      {units.length > 0 && onUnitChange && (
        <div className="tag-filter" style={{ marginTop: '0.4rem' }}>
          <button className={unit === 'all' ? 'active' : ''} onClick={() => onUnitChange('all')}>
            全部单元
          </button>
          {units.map((u) => (
            <button key={u} className={unit === u ? 'active' : ''} onClick={() => onUnitChange(u)}>
              {u} ({unitCount(u)})
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
