import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { masteryLevel } from '../lib/storage';
import { isInWrongBook } from '../lib/checkin';
import {
  todayKey, isDayChecked, computeStreak,
  weekStartKey, addDays, parseKey, dateKeyOf,
  CHECKIN_DAY_GOAL_QUESTIONS, CHECKIN_DAY_GOAL_SECONDS,
} from '../lib/checkin';
import StreakCard from './StreakCard';
import type { View } from '../App';

interface Props {
  go: (v: View) => void;
}

const MODES: { key: View; title: string; desc: string }[] = [
  { key: 'quiz', title: '随堂测验 / 作业', desc: '输入老师给的密码进入限时测验' },
  { key: 'flashcards', title: '闪卡记忆', desc: '翻卡看释义，纯自学浏览' },
  { key: 'choice', title: '选择题测验', desc: '四选一，术语与释义配对' },
  { key: 'chain', title: '逻辑接龙', desc: '沿概念间的逻辑关系一步步接龙' },
  { key: 'cloze', title: '语境填空', desc: '结合上下文语境填入术语' },
  { key: 'spelling', title: '拼写默写', desc: '看中文释义拼写英文术语' },
  { key: 'matching', title: '匹配题', desc: '术语与释义连线配对' },
  { key: 'crossword', title: '纵横填字', desc: '随机生成填字游戏' },
  { key: 'wordle', title: 'Wordle', desc: '猜术语的字母游戏' },
  { key: 'wrong', title: '错题练习', desc: '复习做错的题目' },
];

// 周历：周一到周日顺序（设计图），index 0=周一 … 6=周日
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

export default function Home({ go }: Props) {
  const { vocab, progress, wrongBook, checkin, isTeacher, isDeveloper, skipped, vocabUpdateBanner, syncVocabFromCloud, dismissVocabBanner } = useStore();

  useEffect(() => { syncVocabFromCloud(); }, [syncVocabFromCloud]);

  // 基础统计
  const validIds = useMemo(() => new Set(vocab.map((v) => v.id)), [vocab]);
  const total = vocab.length;
  const mastered = useMemo(
    () => Object.entries(progress).filter(([id, p]) => validIds.has(id) && masteryLevel(p.mastery) >= 3).length,
    [progress, validIds],
  );
  const wrongCount = useMemo(
    () => Object.keys(wrongBook).filter((id) => validIds.has(id) && isInWrongBook(wrongBook[id])).length,
    [wrongBook, validIds],
  );

  // 打卡数据
  const today = todayKey();
  const streak = useMemo(() => computeStreak(checkin), [checkin]);
  const todayStudy = checkin.study[today] || { seconds: 0, questions: 0, correct: 0 };
  const todayDone = Math.min(todayStudy.questions, CHECKIN_DAY_GOAL_QUESTIONS);
  const todayLeft = Math.max(0, CHECKIN_DAY_GOAL_QUESTIONS - todayDone);
  const GOAL_MINUTES = Math.round(CHECKIN_DAY_GOAL_SECONDS / 60);
  const todayMins = Math.floor(todayStudy.seconds / 60);
  const dayDone = todayStudy.seconds >= CHECKIN_DAY_GOAL_SECONDS && todayDone >= CHECKIN_DAY_GOAL_QUESTIONS;
  const needMins = Math.max(0, GOAL_MINUTES - todayMins);

  // 今日目标卡片：题数 / 学习时长 轮播，每 10s 自动切换；
  // 把 goalMetric 作为依赖，使「手动点击切换」后也重新计时，避免刚切完又被自动翻回
  const [goalMetric, setGoalMetric] = useState<'questions' | 'time'>('questions');
  const toggleGoalMetric = () => setGoalMetric((m) => (m === 'questions' ? 'time' : 'questions'));
  useEffect(() => {
    const id = setInterval(toggleGoalMetric, 10000);
    return () => clearInterval(id);
  }, [goalMetric]);

  // 4 项累计统计
  const totalCheckedDays = useMemo(
    () => Object.keys(checkin.study).filter((k) => isDayChecked(checkin, k)).length,
    [checkin],
  );
  const totalQuestions = useMemo(
    () => Object.values(progress).reduce((s, p) => s + p.seenCount, 0),
    [progress],
  );
  const totalCorrect = useMemo(
    () => Object.values(progress).reduce((s, p) => s + p.correctCount, 0),
    [progress],
  );
  const avgAccuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;

  // 周历：本周 7 天（周一→周日）
  const weekStrip = useMemo(() => {
    const start = parseKey(weekStartKey(new Date()));
    return WEEK_LABELS.map((label, i) => {
      const day = addDays(start, i);
      const key = dateKeyOf(day);
      return { key, label, checked: isDayChecked(checkin, key), isToday: key === today };
    });
  }, [checkin, today]);

  return (
    <div>
      {vocabUpdateBanner && (
        <div className="card" style={{ marginBottom: '0.8rem', borderColor: 'var(--c-primary)' }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <span>{vocabUpdateBanner}</span>
            <span className="spacer" />
            <button className="ghost" onClick={dismissVocabBanner}>关闭</button>
          </div>
        </div>
      )}

      {total === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="big">📚</div>
            <h2>欢迎使用社会学词汇</h2>
            {isTeacher ? (
              <>
                <p className="muted">词库还是空的，请先导入 Excel 词汇表开始使用。</p>
                <button className="primary" onClick={() => go('import')} style={{ marginTop: '1rem' }}>
                  导入词汇表
                </button>
              </>
            ) : (
              <p className="muted">词库暂未导入，请等待老师导入词汇表后再来练习。</p>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* ===== 主仪表盘：左（连续学习 + 周历）/ 右（今日目标蓝卡） ===== */}
          <div className="dashboard-hero">
            <div className="dashboard-hero__left">
              <div className="dashboard-streak">
                <span className="dashboard-streak__num">{streak}</span>
                <span className="dashboard-streak__unit">天</span>
                <span className="dashboard-streak__fire" aria-hidden>🔥</span>
              </div>
              <div className="dashboard-streak__sub">
                最长纪录 {checkin.bestStreak} 天
              </div>
              <div className="week-strip" role="list" aria-label="本周打卡">
                {weekStrip.map((d) => (
                  <div
                    key={d.key}
                    role="listitem"
                    className={`week-strip__cell${d.isToday ? ' is-today' : ''}${d.checked ? ' is-checked' : ''}`}
                    title={d.key}
                  >
                    <div className="week-strip__dot" aria-hidden>{d.checked ? '✓' : ''}</div>
                    <div className="week-strip__label">{d.label}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="dashboard-hero__right">
              <div
                className="goal-card"
                onClick={toggleGoalMetric}
                title="点击切换 题数 / 时长"
                style={{ cursor: 'pointer' }}
              >
                <div className="goal-card__title">
                  <span>今日目标</span>
                  <span className="goal-card__dots" aria-hidden>
                    <i className={goalMetric === 'questions' ? 'on' : ''} />
                    <i className={goalMetric === 'time' ? 'on' : ''} />
                  </span>
                </div>
                <div className="goal-card__metric" key={goalMetric}>
                  {goalMetric === 'questions' ? (
                    <div className="goal-card__target">
                      <span className="goal-card__num">{todayDone}</span>
                      <span className="goal-card__sub">/{CHECKIN_DAY_GOAL_QUESTIONS} 题</span>
                    </div>
                  ) : (
                    <div className="goal-card__target">
                      <span className="goal-card__num">{todayMins}</span>
                      <span className="goal-card__sub">/{GOAL_MINUTES} 分钟</span>
                    </div>
                  )}
                </div>
                <div className="goal-card__msg">
                  {dayDone ? '今日已达成，继续保持！' : `还差 ${needMins} 分钟、${todayLeft} 题完成打卡`}
                </div>
                <button
                  className="primary goal-card__cta"
                  onClick={(e) => { e.stopPropagation(); go('choice'); }}
                >
                  继续今日练习
                </button>
              </div>
            </div>
          </div>

          {/* ===== 4 项累计统计 ===== */}
          <div className="stats-row">
            <div className="stats-row__cell">
              <div className="stats-row__num">{totalCheckedDays}</div>
              <div className="stats-row__label">累计打卡（天）</div>
            </div>
            <div className="stats-row__cell">
              <div className="stats-row__num">{totalQuestions.toLocaleString()}</div>
              <div className="stats-row__label">累计题数</div>
            </div>
            <div className="stats-row__cell">
              <div className="stats-row__num">{avgAccuracy}<span className="stats-row__unit">%</span></div>
              <div className="stats-row__label">平均正确率</div>
            </div>
            <div className="stats-row__cell">
              <div className="stats-row__num">{mastered}<span className="stats-row__unit"> / {total}</span></div>
              <div className="stats-row__label">已掌握词条</div>
            </div>
          </div>

          {/* ===== 学习打卡详情（保留 StreakCard：双进度条 + 补签） ===== */}
          <StreakCard />
        </>
      )}

      <h2 style={{ marginTop: '1.2rem' }}>选择练习模式</h2>
      <div className="grid cols-3">
        {/* 语境填空（cloze）尚未完善，仅开发者可见——与导航栏同一权限策略 */}
        {MODES.filter((m) => m.key !== 'cloze' || (isDeveloper && !skipped)).map((m) => (
          <button
            key={m.key}
            className="mode-card card"
            onClick={() => go(m.key)}
            disabled={total === 0}
          >
            <img className="mode-card__icon" src={`/mode-icons/${m.key}.svg`} alt="" />
            <strong>{m.title}</strong>
            <span className="desc">
              {m.key === 'wrong' && wrongCount > 0 ? `待复习 ${wrongCount} 题` : m.desc}
            </span>
            {/* Step 5 接入「上次成绩/待复习数」持久化数据；当前为占位 */}
            <span className="mode-card__meta">—</span>
          </button>
        ))}
      </div>

      <div className="row" style={{ marginTop: '1rem' }}>
        <button onClick={() => go('progress')}>查看进度</button>
      </div>
    </div>
  );
}
