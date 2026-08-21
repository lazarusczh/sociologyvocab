import { useState } from 'react';
import ImportPanel from './ImportPanel';
import TeacherCheckPanel from './TeacherCheckPanel';

// 教师后台（仅教师版显示）：整合「打卡核验」与「词库导入」两块。
// 学生版不打包此入口（见 App.tsx 的守卫）。
export default function AdminPanel() {
  const [tab, setTab] = useState<'check' | 'import'>('check');

  return (
    <div>
      <h1>教师后台</h1>
      <div className="tag-filter" style={{ marginBottom: '0.8rem' }}>
        <button className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>
          打卡核验
        </button>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
          词库导入
        </button>
      </div>
      {tab === 'check' && <TeacherCheckPanel />}
      {tab === 'import' && <ImportPanel />}
    </div>
  );
}
