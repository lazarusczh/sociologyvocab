// OCR 阅卷的「录入记录」存取（Supabase，表 ocr_pages）
//
// 为什么需要：转写结果只放在页面内存里，刷新/关标签就没了 → 只能重新拍照识别，
// 白白多烧模型额度。落库后刷新即可载回文本（高亮在前端重算，**不再调用模型**）。
//
// 隐私：只存**文本**，不存答卷图片（教师手上有纸质原件）。RLS 仅本人可读写。

import { supabase } from './supabase';

/** 列表用：**不含转写正文**。正文动辄数千字，60 条一起拉会让「载入记录 / 刷新」明显变慢 */
export interface OcrRecordMeta {
  id: string;
  label: string | null;
  page_name: string | null;
  text_len: number | null;   // 正文字数（库内触发器维护，列表用它显示「N 字」）
  model: string | null;
  elapsed_ms: number | null;
  created_at: string;
}

/** 完整记录（含正文）：只在点「载入」取单条时用 */
export interface OcrRecord extends OcrRecordMeta {
  text: string;
}

const TABLE = 'ocr_pages';

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** 最近若干条记录（默认 60 条，按时间倒序）—— **只取元信息，不含正文**（2026-09-15 提速） */
export async function listOcrRecordMetas(limit = 60): Promise<OcrRecordMeta[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, label, page_name, text_len, model, elapsed_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as OcrRecordMeta[];
}

/** 取单条正文（点「载入」时才调用，避免列表把全文都拉回来） */
export async function getOcrRecordText(id: string): Promise<string | null> {
  const { data, error } = await supabase.from(TABLE).select('text').eq('id', id).single();
  if (error || !data) return null;
  return (data as { text: string }).text;
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
