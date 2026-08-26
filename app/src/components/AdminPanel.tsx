import { useState } from 'react';
import ImportPanel from './ImportPanel';
import TeacherCheckPanel from './TeacherCheckPanel';
import VocabManager from './VocabManager';
import ClassManager from './ClassManager';
import QuizManager from './QuizManager';

// 教师后台（仅教师版显示）：整合「打卡核验」「班级管理」「随堂测验」「词条管理」「批量导入」五块。
export default function AdminPanel() {
  const [tab, setTab] = useState<'check' | 'classes' | 'quiz' | 'vocab' | 'import'>('check');

  return (
    <div>
      <h1>教师后台</h1>
      <div className="tag-filter" style={{ marginBottom: '0.8rem' }}>
        <button className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>
          打卡核验
        </button>
        <button className={tab === 'classes' ? 'active' : ''} onClick={() => setTab('classes')}>
          班级管理
        </button>
        <button className={tab === 'quiz' ? 'active' : ''} onClick={() => setTab('quiz')}>
          随堂测验
        </button>
        <button className={tab === 'vocab' ? 'active' : ''} onClick={() => setTab('vocab')}>
          词条管理
        </button>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
          批量导入
        </button>
      </div>
      {tab === 'check' && <TeacherCheckPanel />}
      {tab === 'classes' && <ClassManager />}
      {tab === 'quiz' && <QuizManager />}
      {tab === 'vocab' && <VocabManager />}
      {tab === 'import' && <ImportPanel />}
    </div>
  );
}
