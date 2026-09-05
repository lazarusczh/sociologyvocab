import { useState } from 'react';
import ImportPanel from './ImportPanel';
import TeacherCheckPanel from './TeacherCheckPanel';
import VocabManager from './VocabManager';
import LogicManager from './LogicManager';
import ClassManager from './ClassManager';
import QuizManager from './QuizManager';
import Grouper from './Grouper';
import PaperResults from './PaperResults';

// 教师后台（仅教师版显示）：整合「打卡核验」「班级管理」「随堂测验」「组卷器」「试卷成绩」「词条管理」「逻辑管理」「批量导入」八块。
export default function AdminPanel() {
  const [tab, setTab] = useState<'check' | 'classes' | 'quiz' | 'grouper' | 'results' | 'vocab' | 'logic' | 'import'>('check');

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
        <button className={tab === 'grouper' ? 'active' : ''} onClick={() => setTab('grouper')}>
          组卷器
        </button>
        <button className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>
          试卷成绩
        </button>
        <button className={tab === 'vocab' ? 'active' : ''} onClick={() => setTab('vocab')}>
          词条管理
        </button>
        <button className={tab === 'logic' ? 'active' : ''} onClick={() => setTab('logic')}>
          逻辑管理
        </button>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
          批量导入
        </button>
      </div>
      {tab === 'check' && <TeacherCheckPanel />}
      {tab === 'classes' && <ClassManager />}
      {tab === 'quiz' && <QuizManager />}
      {tab === 'grouper' && <Grouper onOpenResults={() => setTab('results')} />}
      {tab === 'results' && <PaperResults />}
      {tab === 'vocab' && <VocabManager />}
      {tab === 'logic' && <LogicManager />}
      {tab === 'import' && <ImportPanel />}
    </div>
  );
}
