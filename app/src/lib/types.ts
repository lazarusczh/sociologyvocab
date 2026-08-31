// 词库条目类型：统一表示术语和学者人名
export interface VocabItem {
  id: string;
  type: 'term' | 'scholar';
  term: string;        // 英文术语 或 学者姓名
  chinese: string;     // 中文翻译（学者人名为空）
  definition: string; // 英文释义 或 学者理论描述
  paper: string;       // 考卷大类：'Paper 1' | 'Paper 2' | 'Paper 3' | 'Paper 4'
  category: string;    // 次级标签（Paper 4 为 Globalisation/Media；Paper 1 合并为空）
  unit?: string[];     // 所属单元（按教学大纲细分；跨单元词条可多个）
  aliases?: string[];  // 可接受答案（手动别名，答案容错；含标准写法与同义/缩写写法）
  theory?: string;     // 理论流派（单值，兼容旧显示逻辑；仅学者使用，术语一律走 theories）
  theories?: string[]; // 理论流派（多选标签，教师后台逐个编辑；学者与术语均可使用）
  notes?: string;      // 备注（仅学者）
}

// 正式练习模式（用于区分掌握度增减权重）
export type PracticeMode = 'choice' | 'spelling' | 'matching' | 'crossword';

// 导入结果
export interface ImportResult {
  items: VocabItem[];
  termCount: number;
  scholarCount: number;
  papers: string[];           // 考卷大类
  categories: string[];       // 次级标签（非空）
  warnings: string[];
  suspiciousScholars: string[]; // 疑似非常规格式的学者名（去重），需用户人工指定姓氏处理方式
}

// 特殊姓氏覆盖表：键为词库原文 term，值为应作为「姓氏」的正确写法（默写时只答此写法即算对）
export type SurnameOverrides = Record<string, string>;

// 单条练习进度
export interface ItemProgress {
  // 掌握度：0-100 连续值；0=未学，1-40=不熟，41-70=熟悉，71-100=掌握
  mastery: number;
  seenCount: number;     // 练习过的次数
  correctCount: number;  // 答对次数
  lastSeen: number;      // 时间戳
}

// 全局进度
export interface Progress {
  [itemId: string]: ItemProgress;
}

// 范文语境（用于选词填空）
export interface ContextPassage {
  id: string;
  title: string;
  text: string;          // 范文原文，用 {{术语}} 标记填空位置
  category?: string;
}

// 每日学习统计（用于打卡）
export interface DayStudy {
  seconds: number;     // 当日累计学习秒数
  questions: number;   // 当日累计正式练习题数
  correct: number;     // 当日累计正式练习答对数
}

// 打卡状态
export interface CheckInState {
  study: Record<string, DayStudy>; // dateKey -> 当日统计
  makeup: Record<string, true>;    // 已补签的日期
  earnedMakeupWeeks: string[];     // 已获得补签机会的周（周一 dateKey）
  bestStreak: number;              // 历史最长连续天数
}

// 错题条目
export interface WrongEntry {
  wrongCount: number;          // 累计答错次数
  consecutiveCorrect: number;  // 连续答对次数
}
export type WrongBook = Record<string, WrongEntry>;

// 备份文件汇总（供快速阅读）
export interface BackupSummary {
  totalCheckinDays: number; // 累计打卡天数（含补签）
  bestStreak: number;       // 最长连续天数
  totalQuestions: number;   // 累计正式练习题数
  wrongCount: number;       // 当前错题本条目数
}

// 云端登录用户（邮箱注册/登录后由 Supabase Auth 提供）
export interface AuthUser {
  id: string;    // Supabase uid（也是 student_data 表的主键 user_id）
  email: string; // 学生邮箱（作为身份标识，替代原学号）
  name: string;  // 姓名（注册时填写，存于 user_metadata，可空）
}

// 备份文件格式（单 JSON 文件；供离线用户当作「数据搬家」自由导出/导入，无校验）
export interface BackupFile {
  version: 1;
  exportedAt: number;     // 导出时间戳（毫秒）
  exportedDate: string;   // 导出时间（可读）
  summary: BackupSummary;
  checkin: CheckInState;
  progress: Progress;
  wrongBook: WrongBook;
}

// ===== 随堂测验 / 作业 =====

// 测验类型：随堂测验（严格限时）/ 作业（放宽时限，可保存退出）
export type QuizKind = 'quiz' | 'homework';

// 选题模式：随机抽题 / 手动指定词条
export type QuizSelectionMode = 'random' | 'manual';

// 测验题型（复用现有练习：拼写 / 选择 / 匹配；语境填空为未来扩展）
export type QuizQuestionType = 'spelling' | 'choice' | 'matching';

// 匹配块中的一对（术语 ↔ 释义）
export interface QuizPair {
  itemId: string;   // 词条稳定 id（术语与释义属同一词条，配对正确 = 两侧 itemId 相同）
  term: string;     // 术语
  definition: string; // 脱敏释义
}

// 单道测验题（生成时固定的快照，保证所有学生同一份题）
export interface QuizQuestion {
  id: string;          // 题目内唯一 id（快照内自增）
  type: QuizQuestionType;
  itemId: string;      // 对应词条稳定 id（判分按此对答案；匹配块为主对 id）
  itemType: 'term' | 'scholar'; // 词条类型（拼写/匹配判分用）
  term: string;        // 标准答案文本（用于判分/展示）
  aliases?: string[];  // 词条可接受答案别名（拼写判分用）
  chinese: string;
  definition: string;  // 已脱敏的释义（maskAnswer 后）
  prompt: string;      // 题干
  promptLabel: string; // 题干标签（术语/释义/中文）
  options?: string[];  // 选择题选项（含正确答案，生成时定序，学生端再乱序）
  answerIndex?: number; // 选择题正确选项在 options 中的下标（学生端乱序前）
  pairs?: QuizPair[];  // 匹配块：一组术语↔释义配对（仅 matching 题型）
}

// 试卷主表记录
export interface Quiz {
  id: string;
  code: string;
  title: string;
  kind: QuizKind;
  selection_mode: QuizSelectionMode;
  papers: string[];
  category: string | null;
  units: string[];
  type_filter: 'all' | 'term' | 'scholar';
  question_count: number;
  duration_minutes: number;
  question_types: QuizQuestionType[];
  questions: QuizQuestion[];
  open_at: string | null;
  due_at: string | null;
  allow_resume: boolean;
  allow_late: boolean;
  grading_rules?: {
    late_penalty?: {
      enabled?: boolean;
      daily_percents?: number[];
    };
  } | null; // 评分规则快照（创建作业时固定；测验为 null）
  created_by: string | null;
  created_at: string;
}

// 交卷记录
export interface QuizSubmission {
  id: string;
  quiz_id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  answers: Record<string, string | number>; // itemId -> 答案（拼写为文本，选择为下标）
  score: number;
  status: 'in_progress' | 'submitted';
  started_at: string;
  submitted_at: string | null;
  leave_count: number;
  leave_seconds: number;
  order_seed: number;
  remaining_seconds: number | null; // 作业剩余答题秒数（in_progress 时冻结；交卷后为 null）
  grading?: {
    late_days?: number;
    penalty_percent?: number;
    penalty?: number;
    bonus?: number;
    final_score?: number;
  } | null; // 评分结算（迟交罚分等；测验/无罚分时为空）
}
