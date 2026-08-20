// 词库条目类型：统一表示术语和学者人名
export interface VocabItem {
  id: string;
  type: 'term' | 'scholar';
  term: string;        // 英文术语 或 学者姓名
  chinese: string;     // 中文翻译（学者人名为空）
  definition: string; // 英文释义 或 学者理论描述
  category: string;    // 所属主题
  theory?: string;     // 学者所属理论流派（仅学者）
  notes?: string;      // 备注（仅学者）
}

// 导入结果
export interface ImportResult {
  items: VocabItem[];
  termCount: number;
  scholarCount: number;
  categories: string[];
  warnings: string[];
}

// 单条练习进度
export interface ItemProgress {
  // 闪卡掌握度：0=未学 1=不熟 2=熟悉 3=掌握
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

// 学生身份（首次填写并锁定，用于防冒名顶替）
export interface StudentIdentity {
  studentId: string; // 学号
  name: string;      // 姓名
  lockedAt: number;  // 锁定时间戳
}

// 备份文件汇总（供教师核验时快速阅读）
export interface BackupSummary {
  totalCheckinDays: number; // 累计打卡天数（含补签）
  bestStreak: number;       // 最长连续天数
  totalQuestions: number;   // 累计正式练习题数
  wrongCount: number;       // 当前错题本条目数
}

// 备份文件格式（单 JSON 文件，附明文身份与隐藏设备指纹）
export interface BackupFile {
  version: 1;
  studentId: string;
  name: string;
  fingerprint: string;    // SHA-256(studentId|deviceCode)，隐藏设备指纹
  exportedAt: number;     // 导出时间戳（毫秒）
  exportedDate: string;   // 导出时间（可读）
  summary: BackupSummary;
  checkin: CheckInState;
  progress: Progress;
  wrongBook: WrongBook;
}
