// 打卡备份：身份绑定、设备指纹、导出 / 导入校验（全部本地，不涉及网络）
import type {
  CheckInState, Progress, WrongBook, StudentIdentity, BackupFile, BackupSummary,
} from './types';
import { isDayChecked, isInWrongBook } from './checkin';
import { saveCheckIn, saveProgress, saveWrongBook } from './storage';
import { verifyResetCode } from './resetCode';

const IDENTITY_KEY = 'socio_vocab_identity';
const DEVICE_KEY = 'socio_vocab_device';
const USED_RESET_KEY = 'socio_vocab_used_reset';

// ---- 设备码（每台设备随机生成一次，仅存本机，不随备份导出）----
export function getDeviceCode(): string {
  let code = localStorage.getItem(DEVICE_KEY);
  if (!code) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    code = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(DEVICE_KEY, code);
  }
  return code;
}

// ---- 身份（首次填写后锁定）----
export function loadIdentity(): StudentIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as StudentIdentity) : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: StudentIdentity): void {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

// ---- 工具 ----
function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  return hex(await crypto.subtle.digest('SHA-256', data));
}

async function fingerprintOf(studentId: string, deviceCode: string): Promise<string> {
  return sha256Hex(`${studentId}|${deviceCode}`);
}

// ---- 已用重置码（一次性，防重放）----
export async function isResetUsed(resetCode: string): Promise<boolean> {
  const h = await sha256Hex(resetCode);
  try {
    const list = JSON.parse(localStorage.getItem(USED_RESET_KEY) || '[]') as string[];
    return list.includes(h);
  } catch {
    return false;
  }
}

export async function markResetUsed(resetCode: string): Promise<void> {
  const h = await sha256Hex(resetCode);
  let list: string[] = [];
  try {
    list = JSON.parse(localStorage.getItem(USED_RESET_KEY) || '[]') as string[];
  } catch {
    list = [];
  }
  localStorage.setItem(USED_RESET_KEY, JSON.stringify([...list, h]));
}

// ---- 导出 ----
export async function buildBackup(
  identity: StudentIdentity,
  checkin: CheckInState,
  progress: Progress,
  wrongBook: WrongBook,
): Promise<BackupFile> {
  const deviceCode = getDeviceCode();
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
    studentId: identity.studentId,
    name: identity.name,
    fingerprint: await fingerprintOf(identity.studentId, deviceCode),
    exportedAt: Date.now(),
    exportedDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    summary,
    checkin,
    progress,
    wrongBook,
  };
}

export async function exportBackupJson(
  identity: StudentIdentity,
  checkin: CheckInState,
  progress: Progress,
  wrongBook: WrongBook,
): Promise<string> {
  const file = await buildBackup(identity, checkin, progress, wrongBook);
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
  if (typeof f.studentId !== 'string' || !f.studentId || typeof f.name !== 'string' || !f.name)
    return { ok: false, message: '备份文件缺少学号或姓名。' };
  if (typeof f.fingerprint !== 'string' || !f.fingerprint)
    return { ok: false, message: '备份文件缺少设备指纹。' };
  if (!f.checkin || !f.progress || !f.wrongBook)
    return { ok: false, message: '备份文件缺少打卡、进度或错题数据。' };
  return { ok: true, file: f };
}

// ---- 同设备导入校验 ----
export async function checkSameDevice(
  file: BackupFile,
  identity: StudentIdentity | null,
  deviceCode: string,
): Promise<{ ok: boolean; message: string }> {
  if (!identity)
    return { ok: false, message: '本机尚未填写学号和姓名。如为换机恢复，请使用重置码导入。' };
  if (identity.studentId !== file.studentId)
    return { ok: false, message: '备份属于其他学生（学号不匹配），导入被拒绝。' };
  const fp = await fingerprintOf(identity.studentId, deviceCode);
  if (fp !== file.fingerprint)
    return { ok: false, message: '设备校验失败：备份来自其他设备。如已换机，请使用重置码恢复。' };
  return { ok: true, message: '' };
}

// ---- 导入（含重置码恢复）----
export async function performImport(
  text: string,
  resetCode: string | null,
): Promise<{ ok: boolean; message: string }> {
  const parsed = parseBackup(text);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const file = parsed.file;

  const usingReset = !!resetCode && !!resetCode.trim();
  if (usingReset) {
    const code = resetCode!.trim();
    const rv = await verifyResetCode(code);
    if (!rv.ok) return { ok: false, message: rv.message };
    if (rv.studentId !== file.studentId)
      return { ok: false, message: '重置码与备份文件的学号不一致，导入被拒绝。' };
    if (await isResetUsed(code))
      return { ok: false, message: '该重置码已使用过，无法再次使用。' };
    // 绑定身份到该学生（换机 / 清空恢复），并覆盖本机记录
    saveIdentity({ studentId: file.studentId, name: file.name, lockedAt: Date.now() });
    await markResetUsed(code);
  } else {
    const identity = loadIdentity();
    const check = await checkSameDevice(file, identity, getDeviceCode());
    if (!check.ok) return { ok: false, message: check.message };
  }

  saveCheckIn(file.checkin);
  saveProgress(file.progress);
  saveWrongBook(file.wrongBook);
  return {
    ok: true,
    message: usingReset
      ? '重置码恢复成功：身份与学习记录已导入。'
      : '导入成功：打卡、进度与错题本已恢复。',
  };
}