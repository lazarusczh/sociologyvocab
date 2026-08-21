// 词库条目类型：统一表示术语和学者人名
export interface VocabItem {
  id: string;
  type: 'term' | 'scholar';
  term: string;        // 英文术语 或 学者姓名
  chinese: string;     // 中文翻译（学者人名为空）
  definition: string; // 英文释义 或 学者理论描述
  paper: string;       // 考卷大类：'Paper 1' | 'Paper 2' | 'Paper 3' | 'Paper 4'
  category: string;    // 次级标签（Paper 4 为 Globalisation/Media；Paper 1 合并为空）
  theory?: string;     // 学者所属理论流派（仅学者）
  notes?: string;      // 备注（仅学者）
}

// 正式练习模式（用于区分掌握度增减权重）
export type PracticeMode = 'choice' | 'spelling' | 'matching';

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
