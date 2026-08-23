import { useState } from 'react';
import ImportPanel from './ImportPanel';
import TeacherCheckPanel from './TeacherCheckPanel';
import VocabManager from './VocabManager';

// 教师后台（仅教师版显示）：整合「打卡核验」「词条管理」「批量导入」三块。
export default function AdminPanel() {
  const [tab, setTab] = useState<'check' | 'vocab' | 'import'>('check');

  return (
    <div>
      <h1>教师后台</h1>
      <div className="tag-filter" style={{ marginBottom: '0.8rem' }}>
        <button className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>
          打卡核验
        </button>
        <button className={tab === 'vocab' ? 'active' : ''} onClick={() => setTab('vocab')}>
          词条管理
        </button>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
          批量导入
        </button>
      </div>
      {tab === 'check' && <TeacherCheckPanel />}
      {tab === 'vocab' && <VocabManager />}
      {tab === 'import' && <ImportPanel />}
    </div>
  );
}
