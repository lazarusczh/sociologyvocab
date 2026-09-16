// 云同步层：登录后与 Supabase 的 student_data 表读写，及本地/云端数据合并
import { supabase } from './supabase';
import type { CheckInState, Progress, WrongBook, VocabItem, Quiz, QuizSubmission, CorrectionResult, SurnameOverrides } from './types';
import { classMatchesGrade, firstPaperNumber, gradeFromPapers, inferGrade, pickShortCode, shortCodeBase, type Grade, type RosterEntry } from './mbSync';

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

// 拉取最新词库（含整份词条 + 单元列表 + 特殊姓氏覆盖 + 版本号；无版本返回 null）
// 注意 surname_overrides 是后加的列：历史发布该字段为 null，调用方需按「没有就用本机」降级。
export async function pullLatestVocab(): Promise<{
  version: number;
  data: VocabItem[];
  unitOrder: Record<string, string[]> | null;
  surnameOverrides: SurnameOverrides | null;
} | null> {
  const { data, error } = await supabase
    .from('vocab_releases')
    .select('version, data, unit_order, surname_overrides')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    version: number;
    data: VocabItem[];
    unit_order: Record<string, string[]> | null;
    surname_overrides: SurnameOverrides | null;
  };
  return {
    version: row.version,
    data: row.data ?? [],
    unitOrder: row.unit_order ?? null,
    surnameOverrides: row.surname_overrides ?? null,
  };
}

// 教师发布词库：插入新版本（version 自增），含词条、单元列表与特殊姓氏覆盖，返回新版本号
export async function publishVocab(
  items: VocabItem[],
  note?: string,
  unitOrder?: Record<string, string[]>,
  surnameOverrides?: SurnameOverrides,
): Promise<number> {
  const nextVersion = (await getLatestVocabVersion()) + 1;
  const { error } = await supabase.from('vocab_releases').insert({
    version: nextVersion,
    data: items,
    note: note ?? '',
    unit_order: unitOrder ?? null,
    surname_overrides: surnameOverrides ?? null,
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
  allow_correction: boolean;
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
    allow_correction: boolean;
    grading_rules: unknown;
  },
): Promise<void> {
  const { error } = await supabase.from('quizzes').update(input).eq('id', quizId);
  if (error) throw error;
}

// 教师重判时刷新试卷快照的拼写题容错（aliases）：只更新 questions 字段，其余保持不变。
// 用于「教师在词库修改容错并发布后，对历史答卷重判」，让快照与当前词库的可接受答案一致。
export async function updateQuizQuestions(quizId: string, questions: Quiz['questions']): Promise<void> {
  const { error } = await supabase.from('quizzes').update({ questions }).eq('id', quizId);
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

// 教师跨卷分析：批量拉取多份试卷的「全部已交卷记录」（仅 status = submitted；RLS 与单卷查看一致）。
// quizIds 数量大时按 ~100 个一批分片，避免 PostgREST URL 过长；纯只读，不影响任何已布置作业。
export async function listSubmissionsByQuizzes(quizIds: string[]): Promise<QuizSubmission[]> {
  const out: QuizSubmission[] = [];
  const CHUNK = 100;
  for (let i = 0; i < quizIds.length; i += CHUNK) {
    const chunk = quizIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('quiz_submissions')
      .select('*')
      .in('quiz_id', chunk)
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: true });
    if (error) throw error;
    out.push(...((data ?? []) as QuizSubmission[]));
  }
  return out;
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

// ---- 题库 / mark scheme（组卷器数据底座，2026-09-05）----
export interface QbRow {
  qid: string;
  session: string;
  paper: number;
  variant: number;
  comp: string;
  q: string | null;
  stem: string;
  statement: string | null;
  marks: string;
  marks_total: number;
  kind: string;
  parts: unknown;
  topics: string[];
  note?: string | null;
}
export interface QbFilter {
  paper?: number;
  session?: string;
  kind?: string;
  marks?: string;
  topic?: string;
}

export async function listQuestionBank(f?: QbFilter): Promise<QbRow[]> {
  let q = supabase.from('question_bank').select('*').order('paper').order('session').order('comp');
  if (f?.paper) q = q.eq('paper', f.paper);
  if (f?.session) q = q.eq('session', f.session);
  if (f?.kind) q = q.eq('kind', f.kind);
  if (f?.marks) q = q.eq('marks', f.marks);
  if (f?.topic) q = q.contains('topics', [f.topic]);
  const { data, error } = await q.limit(2000);
  if (error) throw error;
  return (data ?? []) as QbRow[];
}

export interface MsSectionRow { q: string; page?: number | null; pdf_url?: string | null }

export async function listMsSections(session: string, comp: string): Promise<MsSectionRow[]> {
  const { data, error } = await supabase
    .from('ms_sections')
    .select('q,page,pdf_url')
    .eq('session', session.toLowerCase())
    .eq('comp', comp)
    .order('q');
  if (error) throw error;
  return (data ?? []) as MsSectionRow[];
}

// ---- 组卷成绩（grouper_runs，2026-09-05）----

// 单条成绩登记（registered=true 为已注册账号，key=`account:${user_id}`；false 为手动添加，key=`manual:<ts>`）
export interface GrouperRunScore {
  key: string;
  name: string;
  classId: string | null;  // '' / null = 未分班
  registered: boolean;
  raw: number | null;      // 卷面原始分，null = 未录入
}

// 已折算到当次满分的各等级原始分下限（A* 单独存 a_star）
export interface GrouperThreshold { A: number; B: number; C: number; D: number; E: number }

export interface GrouperRunRow {
  id: string;
  title: string;
  mode: 'template' | 'single' | 'free';
  paper: number;
  template_label: string | null;
  topic: string | null;
  slots: unknown;                     // 解析为 AssembleSlot[]
  full_raw: number;
  thresholds: GrouperThreshold | null;
  a_star: number | null;
  scores: GrouperRunScore[];
  mb_short_code: string | null;        // ManageBac 短码（形如 A1-0712）：创建时生成、之后固定不变
  created_by: string | null;
  created_at: string;
}

export async function createGrouperRun(input: {
  title: string;
  mode: GrouperRunRow['mode'];
  paper: number;
  template_label: string | null;
  topic: string | null;
  slots: unknown;
  full_raw: number;
  thresholds: GrouperThreshold;
  a_star: number | null;
  created_by: string | null;
}): Promise<string> {
  const { data, error } = await supabase
    .from('grouper_runs')
    .insert({ ...input, scores: [] })
    .select('id')
    .single();
  if (error) throw error;
  const id = (data as { id: string }).id;
  // 自动生成 ManageBac 短码（形如 A1-0712）。失败不阻塞创建 —— 详情页还有「生成短码」按钮可补。
  try {
    await ensureRunShortCode(id, input.title, input.paper);
  } catch {
    /* 忽略：短码可事后补生成 */
  }
  return id;
}

// 教师更新某次组卷：标题 / A* 门槛 / 成绩登记数组
export async function updateGrouperRun(
  runId: string,
  patch: { title?: string; a_star?: number | null; scores?: GrouperRunScore[] },
): Promise<void> {
  const { error } = await supabase.from('grouper_runs').update(patch).eq('id', runId);
  if (error) throw error;
}

// 教师查看自己创建的全部组卷记录（倒序）
export async function listGrouperRuns(): Promise<GrouperRunRow[]> {
  const { data, error } = await supabase
    .from('grouper_runs')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as GrouperRunRow[];
}

export async function deleteGrouperRun(runId: string): Promise<void> {
  const { error } = await supabase.from('grouper_runs').delete().eq('id', runId);
  if (error) throw error;
}

// ---- ManageBac 分数同步（2026-09-15）----
// 设计见《分数同步到ManageBac方案.md》；表结构见 db-migration-mb-sync.sql
// 唯一性由应用层保证（迁移注释里说明了原因：本库对唯一/部分/表达式索引支持不确定）

/** 班级 + ManageBac 绑定信息（班级管理页用） */
export interface ClassMbRow {
  id: string;
  name: string;
  papers: string[] | null;
  mb_class_url: string | null;
  mb_class_id: string | null;
}

export async function listClassesWithMb(): Promise<ClassMbRow[]> {
  const { data, error } = await supabase
    .from('classes')
    .select('id, name, papers, mb_class_url, mb_class_id')
    .order('name');
  if (error) throw error;
  return (data ?? []) as ClassMbRow[];
}

/** 绑定 / 解除某班的 ManageBac 成绩册（url 传 null 即解除） */
export async function setClassMbBinding(
  classId: string,
  url: string | null,
  mbClassId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('classes')
    .update({ mb_class_url: url, mb_class_id: mbClassId })
    .eq('id', classId);
  if (error) throw error;
}

/** 已占用的短码（生成时查重；同一次查重覆盖试卷成绩与测验两侧，避免撞码） */
export async function listShortCodes(): Promise<string[]> {
  const [a, b] = await Promise.all([
    supabase.from('grouper_runs').select('mb_short_code').not('mb_short_code', 'is', null),
    supabase.from('quizzes').select('mb_short_code').not('mb_short_code', 'is', null),
  ]);
  if (a.error) throw a.error;
  if (b.error) throw b.error;
  const pick = (rows: unknown[]) =>
    (rows as { mb_short_code: string | null }[]).map((r) => r.mb_short_code ?? '');
  return [...pick(a.data ?? []), ...pick(b.data ?? [])].filter(Boolean);
}

export async function setRunShortCode(runId: string, code: string): Promise<void> {
  const { error } = await supabase.from('grouper_runs').update({ mb_short_code: code }).eq('id', runId);
  if (error) throw error;
}

/** 年级位：优先用同名班级的 papers（P1/P2 → A1、P3/P4 → A2），否则按卷名/paper */
async function gradeForRun(title: string, paper: number): Promise<Grade> {
  const guess = inferGrade(title, paper);
  try {
    const { data } = await supabase.from('classes').select('name, papers');
    const rows = (data ?? []) as { name: string; papers: string[] | null }[];
    const hit = rows.find((c) => classMatchesGrade(c.name, guess));
    return (hit ? gradeFromPapers(hit.papers) : null) ?? guess;
  } catch {
    return guess;
  }
}

/** 生成并落库短码（幂等：已有则原样返回）。新记录在 createGrouperRun 里自动调用。 */
export async function ensureRunShortCode(
  runId: string,
  title: string,
  paper: number,
  force = false,
  gradeOverride: Grade | null = null,
): Promise<string> {
  const { data: cur } = await supabase
    .from('grouper_runs')
    .select('mb_short_code')
    .eq('id', runId)
    .single();
  const existing = (cur as { mb_short_code: string | null } | null)?.mb_short_code ?? null;
  if (existing && !force) return existing;
  const grade = gradeOverride ?? await gradeForRun(title, paper);
  const taken = await listShortCodes();
  // force 时排除自己现用的码，避免查重把旧码算成冲突
  const code = pickShortCode(shortCodeBase(grade), taken.filter((c) => c !== existing));
  await setRunShortCode(runId, code);
  return code;
}

/** 已绑定的 ManageBac task（一条作业可绑多个班 → 多行；run_id 与 quiz_id 二选一） */
export interface MbTaskLinkRow {
  id: string;
  run_id: string | null;    // 试卷成绩侧
  quiz_id: string | null;   // 随堂测验 / 作业侧
  class_id: string;
  mb_class_id: string | null;
  mb_task_id: string;
  mb_task_name: string | null;
  bound_at: string | null;
}

export async function listMbTaskLinks(runId: string): Promise<MbTaskLinkRow[]> {
  const { data, error } = await supabase
    .from('mb_task_links')
    .select('*')
    .eq('run_id', runId)
    .order('bound_at');
  if (error) throw error;
  return (data ?? []) as MbTaskLinkRow[];
}

/** 某个测验 / 作业已绑定的 ManageBac task */
export async function listMbTaskLinksForQuiz(quizId: string): Promise<MbTaskLinkRow[]> {
  const { data, error } = await supabase
    .from('mb_task_links')
    .select('*')
    .eq('quiz_id', quizId)
    .order('bound_at');
  if (error) throw error;
  return (data ?? []) as MbTaskLinkRow[];
}

/**
 * 调 Worker 抓该班 task 列表并按短码精确匹配（**只读**，Worker 侧不写任何数据）。
 * 拿到唯一命中的 task 后，由前端再调 replaceMbTaskLink 落库。
 */
export interface MbTaskMatchResult {
  ok: boolean;
  target?: string;
  term?: string;
  taskCount?: number;
  tasks?: { id: string; name: string }[];
  match: { id: string; name: string } | null;
  matchCount?: number;
  reason?: string | null;
  error?: string;
  hint?: string;
  elapsedMs?: number;
}

export async function matchMbTask(mbClassId: string, code: string): Promise<MbTaskMatchResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? '';
  if (!token) throw new Error('未登录');
  const res = await fetch('/app-api/mb/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ classId: mbClassId, code }),
  });
  const body = (await res.json()) as MbTaskMatchResult;
  if (!res.ok) {
    throw new Error([body.error, body.hint].filter(Boolean).join(' —— ') || `HTTP ${res.status}`);
  }
  return body;
}

/**
 * 绑定：同一作业在同一班级只保留一条（先按 run|quiz + class_id 清旧行，再写新行）。
 * runId 与 quizId 二选一 —— 试卷成绩用 runId，随堂测验/作业用 quizId。
 */
export async function replaceMbTaskLink(input: {
  runId?: string;
  quizId?: string;
  classId: string;
  mbClassId: string | null;
  mbTaskId: string;
  mbTaskName: string;
}): Promise<void> {
  let del = supabase.from('mb_task_links').delete().eq('class_id', input.classId);
  del = input.runId ? del.eq('run_id', input.runId) : del.eq('quiz_id', input.quizId ?? '');
  const { error: delErr } = await del;
  if (delErr) throw delErr;

  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from('mb_task_links').insert({
    run_id: input.runId ?? null,
    quiz_id: input.quizId ?? null,
    class_id: input.classId,
    mb_class_id: input.mbClassId,
    mb_task_id: input.mbTaskId,
    mb_task_name: input.mbTaskName,
    bound_by: auth?.user?.id ?? null,
  });
  if (error) throw error;
}

/** 解绑 */
export async function deleteMbTaskLink(id: string): Promise<void> {
  const { error } = await supabase.from('mb_task_links').delete().eq('id', id);
  if (error) throw error;
}

export interface MbRosterRow {
  email: string;
  mb_name: string;
}

export async function listMbRoster(classId: string): Promise<MbRosterRow[]> {
  const { data, error } = await supabase
    .from('mb_rosters')
    .select('email, mb_name')
    .eq('class_id', classId)
    .order('mb_name');
  if (error) throw error;
  return (data ?? []) as MbRosterRow[];
}

/** 各班名单条数（班级管理页一次拿全，避免 N 次查询） */
export async function countMbRosterByClass(): Promise<Record<string, number>> {
  const { data, error } = await supabase.from('mb_rosters').select('class_id');
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as { class_id: string }[]) out[r.class_id] = (out[r.class_id] ?? 0) + 1;
  return out;
}

/** 整班替换名单（应用层保证唯一：先清空该班再整批写入） */
export async function replaceMbRoster(
  classId: string,
  rows: RosterEntry[],
  importedBy: string | null,
): Promise<number> {
  const { error: delErr } = await supabase.from('mb_rosters').delete().eq('class_id', classId);
  if (delErr) throw delErr;
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    class_id: classId,
    email: r.email.toLowerCase(),
    mb_name: r.mbName,
    imported_by: importedBy,
  }));
  const { error } = await supabase.from('mb_rosters').insert(payload);
  if (error) throw error;
  return payload.length;
}

/**
 * 生成并落库测验 / 作业的短码（幂等：已有则原样返回）。
 * 年级位由 quizzes.papers 推（P1/P2 → A1、P3/P4 → A2）；推不出时用 gradeOverride（教师在界面上选）。
 */
export async function ensureQuizShortCode(
  quizId: string,
  title: string,
  papers: string[] | null | undefined,
  gradeOverride?: Grade | null,
  force = false,
): Promise<string> {
  const { data: cur } = await supabase
    .from('quizzes')
    .select('mb_short_code')
    .eq('id', quizId)
    .single();
  const existing = (cur as { mb_short_code: string | null } | null)?.mb_short_code ?? null;
  if (existing && !force) return existing;
  // 年级位：**优先读作业名**（教师会在名字里写 AS / A2，2026-09-15 明确），其次 papers，最后 A1
  const grade = gradeOverride ?? inferGrade(title, firstPaperNumber(papers));
  const taken = await listShortCodes();
  // force 时排除自己现用的码，避免查重把旧码算成冲突
  const code = pickShortCode(shortCodeBase(grade), taken.filter((c) => c !== existing));
  const { error } = await supabase.from('quizzes').update({ mb_short_code: code }).eq('id', quizId);
  if (error) throw error;
  return code;
}

/**
 * 「不登 ManageBac 分」标记。
 * 用途：学生不在 ManageBac 名单里（如自学学生），置 true 后名单缺口提示与同步预览都会跳过她，
 * 不再当作"名单缺人"反复报警。
 */
export async function setStudentMbExempt(userId: string, exempt: boolean): Promise<void> {
  const { error } = await supabase.from('student_data').update({ mb_exempt: exempt }).eq('user_id', userId);
  if (error) throw error;
}
