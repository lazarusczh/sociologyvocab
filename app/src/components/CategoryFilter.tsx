import type { VocabItem } from '../lib/types';

interface Props {
  items: VocabItem[];
  categories: string[];
  selected: string; // 'all' or category name
  onSelect: (cat: string) => void;
  typeFilter?: 'all' | 'term' | 'scholar';
  onTypeChange?: (t: 'all' | 'term' | 'scholar') => void;
}

export default function CategoryFilter({
  items,
  categories,
  selected,
  onSelect,
  typeFilter = 'all',
  onTypeChange,
}: Props) {
  const count = (cat: string) =>
    items.filter((i) => (cat === 'all' || i.category === cat) && (typeFilter === 'all' || i.type === typeFilter)).length;

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
          <span className="muted" style={{ fontSize: '0.85rem' }}>共 {count(selected)} 条</span>
        </div>
      )}
      <div className="tag-filter">
        <button className={selected === 'all' ? 'active' : ''} onClick={() => onSelect('all')}>
          全部主题
        </button>
        {categories.map((c) => (
          <button key={c} className={selected === c ? 'active' : ''} onClick={() => onSelect(c)}>
            {c} ({count(c)})
          </button>
        ))}
      </div>
    </div>
  );
}
