import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface GateRow {
  disabled_at: string | null;
  note: string;
  updated_at: string;
}

// AI 问答门禁：教师临时暂停「学生」对知识库 AI 问答的访问（防论文/考试作弊）。
// teacher/developer 在 Worker 侧豁免；切换即时生效，学生收到 note（或默认文案）。
export default function AiGatePanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [note, setNote] = useState('');
  const [meta, setMeta] = useState<{ updated_at?: string; error?: string }>({});

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('ai_gate')
      .select('disabled_at,note,updated_at')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      setMeta({ error: error.message });
    } else {
      const row = (data ?? {}) as Partial<GateRow>;
      setDisabled(!!row.disabled_at);
      setNote(row.note ?? '');
      setMeta({ updated_at: row.updated_at ?? undefined });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 开关即主操作：勾选=拦截学生，取消=恢复。saving 期间禁用防重复。
  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    const { data: sess } = await supabase.auth.getSession();
    const payload = {
      disabled_at: next ? new Date().toISOString() : null,
      note,
      updated_by: sess.session?.user?.id ?? null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('ai_gate').update(payload).eq('id', 1);
    setSaving(false);
    if (error) {
      setMeta({ error: error.message });
      return;
    }
    setDisabled(next);
    setMeta({ updated_at: payload.updated_at });
  };

  const saveNoteOnly = async () => {
    if (saving) return;
    setSaving(true);
    const { error } = await supabase.from('ai_gate').update({ note, updated_at: new Date().toISOString() }).eq('id', 1);
    setSaving(false);
    if (error) setMeta({ error: error.message });
    else setMeta({ updated_at: new Date().toISOString() });
  };

  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>AI 问答门禁</h3>
        <span className="spacer" />
        <button className="ghost" onClick={load} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>
      <p className="muted" style={{ marginTop: '0.5rem' }}>
        考试 / 论文期间可临时暂停「学生」的知识库 AI 问答（教师与开发者不受影响）。切换即时生效，作用于线上 <code>/skill-api/ask</code>。
      </p>

      <div className="gate-switch-row">
        <label className="switch" title="暂停学生 AI 问答">
          <input
            type="checkbox"
            checked={disabled}
            disabled={saving}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span className="switch__track"><span className="switch__thumb" /></span>
        </label>
        <div className="gate-switch-meta">
          <div className="gate-switch-title">暂停学生 AI 问答</div>
          <div className="row tight">
            <span className={disabled ? 'badge danger' : 'badge success'}>
              {disabled ? '已暂停' : '运行中'}
            </span>
            <span className="muted gate-switch-sub">
              {disabled ? '学生提问会被拦截' : '学生可正常使用'}
            </span>
          </div>
        </div>
      </div>

      <div className="gate-note">
        <label className="gate-note-label">学生可见提示语</label>
        <textarea
          rows={2}
          placeholder="例：AI 问答在考试期间暂时关闭，请独立完成；有疑问联系老师。留空则用默认文案。"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="row">
          <button className="ghost" onClick={saveNoteOnly} disabled={saving}>
            {saving ? '保存中…' : '仅保存提示语'}
          </button>
          {meta.updated_at && (
            <span className="muted gate-time">
              最近设置：{new Date(meta.updated_at).toLocaleString('zh-CN', { hour12: false })}
            </span>
          )}
        </div>
      </div>

      {meta.error && <p className="gate-error">操作失败：{meta.error}</p>}
    </div>
  );
}
