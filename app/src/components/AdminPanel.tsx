import { useState } from 'react';
import ImportPanel from './ImportPanel';
import ResetTool from './ResetTool';

// 教师后台（仅教师版显示）：整合「词库导入」与「重置码工具」两块。
// 学生版不打包此入口（见 App.tsx 的 IS_ADMIN 守卫）。
export default function AdminPanel() {
  const [tab, setTab] = useState<'import' | 'reset'>('import');

  return (
    <div>
      <h1>教师后台</h1>
      <div className="tag-filter" style={{ marginBottom: '0.8rem' }}>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
          词库导入
        </button>
        <button className={tab === 'reset' ? 'active' : ''} onClick={() => setTab('reset')}>
          重置码工具
        </button>
      </div>
      {tab === 'import' ? <ImportPanel /> : <ResetTool />}
    </div>
  );
}