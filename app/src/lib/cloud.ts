// 云同步层：登录后与 Supabase 的 student_data 表读写，及本地/云端数据合并
import { supabase } from './supabase';
import type { CheckInState, Progress, WrongBook, VocabItem, Quiz, QuizSubmission, CorrectionResult } from './types';

// 云端 student_data.data 里存储的 JSON 结构（checkin/progress/wrongBook 三块 + 姓名）
export interface CloudStudentData {
  name?: string;
  checkin: CheckInState;
  progress: Progress;
  wrongBook: WrongBook;
}

// 规范化云端返回的数据，确保字段完整（容错）
function normalizeCloudData(raw: unknown): CloudStudentData {
  const d = (raw ?? {}) as Partial<CloudStudentData>;
  return {
    name: d.name,
    checkin: {
      study: d.checkin?.study ?? {},
      makeup: d.checkin?.makeup ?? {},
      earnedMakeupWeeks: d.checkin?.earnedMakeupWeeks ?? [],
      bestStreak: d.checkin?.bestStreak ?? 0,
    },
    progress: d.progress ?? {},
    wrongBook: d.wrongBook ?? {},
  };
}

// 合并：本地优先，云端补充（用于登录时「拉取合并」）
// 原则：两边都有的数据取「更大/更新」的一方，避免换机后丢失或回退。
export function mergeStudentData(
  local: CloudStudentData,
  cloud: CloudStudentData,
): CloudStudentData {
  // 打卡：按日期合并，每日统计取最大值（两个设备累计不丢失）
  const study: CheckInState['study'] = { ...local.checkin.study };
  for (const [day, cd] of Object.entries(cloud.checkin.study)) {
    const ld = study[day];
    if (!ld) {
      study[day] = cd;
    } else {
      study[day] = {
        seconds: Math.max(ld.seconds, cd.seconds),
        questions: Math.max(ld.questions, cd.questions),
        correct: Math.max(ld.correct, cd.correct),
      };
    }
  }
  const makeup: CheckInState['makeup'] = { ...local.checkin.makeup, ...cloud.checkin.makeup };
  const earnedMakeupWeeks = Array.from(
    new Set([...(local.checkin.earnedMakeupWeeks ?? []), ...(cloud.checkin.earnedMakeupWeeks ?? [])]),
  );
  const bestStreak = Math.max(local.checkin.bestStreak ?? 0, cloud.checkin.bestStreak ?? 0);

  // 进度：按词条合并，取 lastSeen 更新的一方（最近练习结果胜出）
  const progress: Progress = { ...local.progress };
  for (const [id, cp] of Object.entries(cloud.progress)) {
    const lp = progress[id];
    if (!lp || (cp.lastSeen ?? 0) >= (lp.lastSeen ?? 0)) {
      progress[id] = cp;
    }
  }

  // 错题本：按词条合并，取累计错题数更大、连续答对更多的一方
  const wrongBook: WrongBook = { ...local.wrongBook };
  for (const [id, cw] of Object.entries(cloud.wrongBook)) {
    const lw = wrongBook[id];
    if (!lw) {
      wrongBook[id] = cw;
    } else {
      wrongBook[id] = {
        wrongCount: Math.max(lw.wrongCount, cw.wrongCount),
        consecutiveCorrect: Math.max(lw.consecutiveCorrect, cw.consecutiveCorrect),
      };
    }
  }

  return {
    name: local.name || cloud.name,
    checkin: { study, makeup, earnedMakeupWeeks, bestStreak },
    progress,
    wrongBook,
  };
}

// 拉取当前登录学生的云端数据（无记录返回 null）
export async function pullCloudData(userId: string): Promise<CloudStudentData | null> {
  const { data, error } = await supabase
    .from('student_data')
    .select('data')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeCloudData((data as { data: unknown }).data) : null;
}

// 上传当前登录学生的数据（upsert：存在则覆盖，不存在则插入）
export async function pushCloudData(
  userId: string,
  email: string,
  payload: CloudStudentData,
): Promise<void> {
  const { error } = await supabase.from('student_data').upsert({
    user_id: userId,
    email,
    data: payload,
  });
  if (error) throw error;
}

// ---- 词库发布 / 拉取 ----

// 查最新词库版本号（轻量，用于「检查更新」；无版本返回 0）
export async function getLatestVocabVersion(): Promise<number> {
  const { data } = await supabase
    .from('vocab_releases')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data as { version: number } | null)?.version ?? 0);
}

// 拉取最新词库（含整份词条 + 单元列表 + 版本号；无版本返回 null）
export async function pullLatestVocab(): Promise<{ version: number; data: VocabItem[]; unitOrder: Record<string, string[]> | null } | null> {
  const { data, error } = await supabase
    .from('vocab_releases')
    .select('version, data, unit_order')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { version: number; data: VocabItem[]; unit_order: Record<string, string[]> | null };
  return { version: row.version, data: row.data ?? [], unitOrder: row.unit_order ?? null };
}

// 教师发布词库：插入新版本（version 自增），含词条与单元列表，返回新版本号
export async function publishVocab(items: VocabItem[], note?: string, unitOrder?: Record<string, string[]>): Promise<number> {
  const nextVersion = (await getLatestVocabVersion()) + 1;
  const { error } = await supabase.from('vocab_releases').insert({
    version: nextVersion,
    data: items,
    note: note ?? '',
    unit_order: unitOrder ?? null,
  });
  if (error) throw error;
  return nextVersion;
}

// ---- 随堂测验 / 作业 ----

// 教师创建测验/作业：插入 quizzes 表，返回生成的密码（code）
export async function createQuiz(input: {
  title: string;
  kind: 'quiz' | 'homework';
  selection_mode: 'random' | 'manual';
  papers: string[];
  category: string | null;
  units: string[];
  type_filter: 'all' | 'term' | 'scholar';
  question_count: number;
  duration_minutes: number;
  question_types: string[];
  questions: Quiz['questions'];
  open_at: string | null;
  due_at: string | null;
  allow_resume: boolean;
  allow_late: boolean;
  grading_rules: unknown;
  created_by: string | null;
}): Promise<string> {
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const { error } = await supabase.from('quizzes').insert({ ...input, code });
  if (error) throw error;
  return code;
}

// 教师更新测验/作业（编辑后保存；code 保持不变）
export async function updateQuiz(
  quizId: string,
  input: {
    title: string;
    kind: 'quiz' | 'homework';
    selection_mode: 'random' | 'manual';
    papers: string[];
    category: string | null;
    units: string[];
    type_filter: 'all' | 'term' | 'scholar';
    question_count: number;
    duration_minutes: number;
    question_types: string[];
    questions: Quiz['questions'];
    open_at: string | null;
    due_at: string | null;
    allow_resume: boolean;
    allow_late: boolean;
    grading_rules: unknown;
  },
): Promise<void> {
  const { error } = await supabase.from('quizzes').update(input).eq('id', quizId);
  if (error) throw error;
}

// 学生凭密码拉取试卷（校验 open_at 由前端做）
export async function getQuizByCode(code: string): Promise<Quiz | null> {
  const { data, error } = await supabase
    .from('quizzes')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (error) throw error;
  return (data as Quiz | null) ?? null;
}

// 学生拉取自己的交卷记录（判断是否已交卷/恢复草稿）
export async function getMySubmission(quizId: string, userId: string): Promise<QuizSubmission | null> {
  const { data, error } = await supabase
    .from('quiz_submissions')
    .select('*')
    .eq('quiz_id', quizId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as QuizSubmission | null) ?? null;
}

// 学生保存草稿 / 交卷（upsert：无则插入，有则更新）
export async function upsertSubmission(input: {
  quiz_id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  answers: Record<string, string | number>;
  score: number;
  status: 'in_progress' | 'submitted';
  started_at: string;
  submitted_at: string | null;
  leave_count: number;
  leave_seconds: number;
  order_seed: number;
  remaining_seconds?: number | null; // 作业保存退出时冻结的剩余秒数
}): Promise<void> {
  const { error } = await supabase.from('quiz_submissions').upsert(input, { onConflict: 'quiz_id,user_id' });
  if (error) throw error;
}

// 学生交卷：走 RPC（security definer），服务器时间判断作业提交截止，硬拦截迟交
export async function submitQuizSubmission(input: {
  quiz_id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  answers: Record<string, string | number>;
  score: number;
  started_at: string;
  leave_count: number;
  leave_seconds: number;
  order_seed: number;
  total_points: number; // 满分（用于迟交罚分计算）
}): Promise<void> {
  const { error } = await supabase.rpc('submit_quiz_submission', input);
  if (error) throw error;
}

// 学生保存订正结果：写入 correction 明细 + 更新 grading（加分/最终分）
// 用 correction IS NULL 作服务端兜底——已订正的记录会被 RLS/条件拦截，防止重复订正覆盖
export async function saveCorrection(
  submissionId: string,
  correction: CorrectionResult,
  grading: NonNullable<QuizSubmission['grading']>,
): Promise<void> {
  const { data, error } = await supabase
    .from('quiz_submissions')
    .update({ correction, grading })
    .eq('id', submissionId)
    .is('correction', null)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('该答卷已完成过订正，不能重复订正');
}

// 教师重判某试卷：传入 submission_id -> 新分数，RPC 批量更新（security definer，仅 teacher/developer 可调用）
export async function regradeQuizSubmissions(quizId: string, scores: Record<string, number>): Promise<number> {
  const { data, error } = await supabase.rpc('regrade_quiz_submissions', {
    p_quiz_id: quizId,
    p_scores: scores,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

// 教师查看某试卷的全部交卷记录
export async function listQuizSubmissions(quizId: string): Promise<QuizSubmission[]> {
  const { data, error } = await supabase
    .from('quiz_submissions')
    .select('*')
    .eq('quiz_id', quizId)
    .order('submitted_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as QuizSubmission[];
}

// 教师查看多份试卷各自的「已提交人数」（仅统计 status = submitted 的记录）
export async function countSubmittedByQuizzes(quizIds: string[]): Promise<Record<string, number>> {
  if (quizIds.length === 0) return {};
  const { data, error } = await supabase
    .from('quiz_submissions')
    .select('quiz_id')
    .in('quiz_id', quizIds)
    .eq('status', 'submitted');
  if (error) throw error;
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { quiz_id: string }[]) {
    counts[row.quiz_id] = (counts[row.quiz_id] ?? 0) + 1;
  }
  return counts;
}

// 教师查看自己创建的全部试卷（按创建时间倒序）
export async function listQuizzes(): Promise<Quiz[]> {
  const { data, error } = await supabase
    .from('quizzes')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Quiz[];
}

// 教师删除试卷（连带级联删除交卷记录）
export async function deleteQuiz(quizId: string): Promise<void> {
  const { error } = await supabase.from('quizzes').delete().eq('id', quizId);
  if (error) throw error;
}

// 查询所有 developer 账户的 user_id（教师端识别测试记录用）
export async function listDeveloperIds(): Promise<string[]> {
  const { data } = await supabase.from('user_roles').select('user_id').eq('role', 'developer');
  return ((data ?? []) as { user_id: string }[]).map((d) => d.user_id);
}

// 教师删除某条答题记录（RLS 限制：仅 developer 账户的记录可删）
export async function deleteSubmission(submissionId: string): Promise<void> {
  const { error } = await supabase.from('quiz_submissions').delete().eq('id', submissionId);
  if (error) throw error;
}

// 学生查看自己已提交的全部测验/作业（含对应试卷信息，按交卷时间倒序）
export async function listMySubmissions(userId: string): Promise<{ sub: QuizSubmission; quiz: Quiz | null }[]> {
  const { data: subs, error } = await supabase
    .from('quiz_submissions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  const list = (subs ?? []) as QuizSubmission[];
  if (list.length === 0) return [];
  const quizIds = [...new Set(list.map((s) => s.quiz_id))];
  const { data: quizzes } = await supabase.from('quizzes').select('*').in('id', quizIds);
  const quizMap = new Map(((quizzes ?? []) as Quiz[]).map((q) => [q.id, q]));
  return list.map((sub) => ({ sub, quiz: quizMap.get(sub.quiz_id) ?? null }));
}
