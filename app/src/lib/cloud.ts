// 云同步层：登录后与 Supabase 的 student_data 表读写，及本地/云端数据合并
import { supabase } from './supabase';
import type { CheckInState, Progress, WrongBook, VocabItem } from './types';

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

// 拉取最新词库（含整份词条 + 版本号；无版本返回 null）
export async function pullLatestVocab(): Promise<{ version: number; data: VocabItem[] } | null> {
  const { data, error } = await supabase
    .from('vocab_releases')
    .select('version, data')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { version: number; data: VocabItem[] };
  return { version: row.version, data: row.data ?? [] };
}

// 教师发布词库：插入新版本（version 自增），返回新版本号
export async function publishVocab(items: VocabItem[], note?: string): Promise<number> {
  const nextVersion = (await getLatestVocabVersion()) + 1;
  const { error } = await supabase.from('vocab_releases').insert({
    version: nextVersion,
    data: items,
    note: note ?? '',
  });
  if (error) throw error;
  return nextVersion;
}
