// OCR 阅卷的「录入记录」存取（Supabase，表 ocr_pages）
//
// 为什么需要：转写结果只放在页面内存里，刷新/关标签就没了 → 只能重新拍照识别，
// 白白多烧模型额度。落库后刷新即可载回文本（高亮在前端重算，**不再调用模型**）。
//
// 隐私：只存**文本**，不存答卷图片（教师手上有纸质原件）。RLS 仅本人可读写。

import { supabase } from './supabase';

export interface OcrRecord {
  id: string;
  label: string | null;
  page_name: string | null;
  text: string;
  model: string | null;
  elapsed_ms: number | null;
  created_at: string;
}

const TABLE = 'ocr_pages';

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** 最近若干条记录（默认 60 条，按时间倒序） */
export async function listOcrRecords(limit = 60): Promise<OcrRecord[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, label, page_name, text, model, elapsed_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as OcrRecord[];
}

/** 新增一条记录，返回记录 id；失败返回 null（UI 只提示，不阻断识别） */
export async function saveOcrRecord(input: {
  label?: string;
  pageName: string;
  text: string;
  model?: string;
  elapsedMs?: number;
}): Promise<string | null> {
  const uid = await currentUserId();
  if (!uid) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      teacher_id: uid,
      label: input.label?.trim() || null,
      page_name: input.pageName,
      text: input.text,
      model: input.model ?? null,
      elapsed_ms: input.elapsedMs ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

/** 重新识别同一页时覆盖旧记录（避免同页堆出多条、也便于保持额度账目干净） */
export async function updateOcrRecord(
  id: string,
  patch: { text: string; model?: string; elapsedMs?: number },
): Promise<boolean> {
  const { error } = await supabase
    .from(TABLE)
    .update({ text: patch.text, model: patch.model ?? null, elapsed_ms: patch.elapsedMs ?? null })
    .eq('id', id);
  return !error;
}

/** 更新备注（学生姓名等） */
export async function updateOcrRecordLabel(id: string, label: string): Promise<boolean> {
  const { error } = await supabase.from(TABLE).update({ label: label.trim() || null }).eq('id', id);
  return !error;
}

export async function deleteOcrRecord(id: string): Promise<boolean> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  return !error;
}
