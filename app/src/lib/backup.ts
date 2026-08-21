// 离线备份：导出 / 导入（纯本地，不涉及网络，无校验）
// 仅服务「跳过登录、离线使用」的游客用户：备份当作「数据搬家」，可在任意设备自由导出/导入。
import type {
  CheckInState, Progress, WrongBook, BackupFile, BackupSummary,
} from './types';
import { isDayChecked, isInWrongBook } from './checkin';
import { saveCheckIn, saveProgress, saveWrongBook } from './storage';

// ---- 导出 ----
export async function buildBackup(
  checkin: CheckInState,
  progress: Progress,
  wrongBook: WrongBook,
): Promise<BackupFile> {
  const checkedDays = new Set<string>();
  Object.keys(checkin.study).forEach((k) => {
    if (isDayChecked(checkin, k)) checkedDays.add(k);
  });
  Object.keys(checkin.makeup).forEach((k) => checkedDays.add(k));
  const totalQuestions = Object.values(checkin.study).reduce((s, d) => s + d.questions, 0);
  const wrongCount = Object.keys(wrongBook).filter((id) => isInWrongBook(wrongBook[id])).length;

  const summary: BackupSummary = {
    totalCheckinDays: checkedDays.size,
    bestStreak: checkin.bestStreak,
    totalQuestions,
    wrongCount,
  };

  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  return {
    version: 1,
    exportedAt: Date.now(),
    exportedDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    summary,
    checkin,
    progress,
    wrongBook,
  };
}

export async function exportBackupJson(
  checkin: CheckInState,
  progress: Progress,
  wrongBook: WrongBook,
): Promise<string> {
  const file = await buildBackup(checkin, progress, wrongBook);
  return JSON.stringify(file, null, 2);
}

// ---- 解析 ----
export function parseBackup(text: string): { ok: true; file: BackupFile } | { ok: false; message: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: '文件不是有效的 JSON，导入失败。' };
  }
  const f = data as BackupFile;
  if (!f || typeof f !== 'object' || f.version !== 1)
    return { ok: false, message: '备份文件版本不支持。' };
  if (!f.checkin || !f.progress || !f.wrongBook)
    return { ok: false, message: '备份文件缺少打卡、进度或错题数据。' };
  return { ok: true, file: f };
}

// ---- 导入 ----
export async function performImport(
  text: string,
): Promise<{ ok: boolean; message: string }> {
  const parsed = parseBackup(text);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const file = parsed.file;

  saveCheckIn(file.checkin);
  saveProgress(file.progress);
  saveWrongBook(file.wrongBook);
  return { ok: true, message: '导入成功：打卡、进度与错题本已恢复。' };
}
