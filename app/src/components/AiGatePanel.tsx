import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface GateRow {
  disabled_at: string | null;
  note: string;
  updated_at: string;
}

// AI 问答门禁：教师临时关闭「学生」对知识库 AI 问答的访问（防论文/考试作弊）。
// teacher/developer 在 Worker 侧豁免；关闭即生效，学生收到 note（或默认文案）。
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

  const apply = async (disable: boolean) => {
    if (saving) return;
    setSaving(true);
    const { data: sess } = await supabase.auth.getSession();
    const payload = {
      disabled_at: disable ? new Date().toISOString() : null,
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
    setDisabled(disable);
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
    <div>
      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>AI 问答门禁</h3>
          <span className="spacer" />
          <button className="ghost" onClick={load} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
        <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
          考试/论文期间可临时关闭「学生」的知识库 AI 问答（教师与开发者不受影响）。关闭即生效，作用于线上 <code>/skill-api/ask</code>。
        </p>

        <div
          style={{
            display: 'inline-block',
            margin: '0.4rem 0 0.2rem',
            padding: '3px 12px',
            borderRadius: 12,
            fontSize: '0.85rem',
            fontWeight: 600,
            background: disabled ? '#fbe3e3' : '#e4f2e7',
            color: disabled ? '#b03030' : '#1e7a34',
          }}
        >
          {disabled ? '● 已关闭：学生提问会被拦截' : '● 开启中：学生可正常使用 AI 问答'}
        </div>

        <p className="muted" style={{ margin: '0.4rem 0 0', fontSize: '0.8rem' }}>
          {disabled ? '如需临时允许学生使用，点下方「恢复开启」。' : '如需在考试期间拦截学生，先填提示语再点「临时关闭」。'}
        </p>

        {meta.error && (
          <p style={{ color: '#c0392b', margin: '0.4rem 0 0', fontSize: '0.85rem' }}>操作失败：{meta.error}</p>
        )}
        {meta.updated_at && (
          <p className="muted" style={{ margin: '0.3rem 0 0', fontSize: '0.75rem' }}>
            最近设置时间：{new Date(meta.updated_at).toLocaleString('zh-CN', { hour12: false })}
          </p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>学生可见提示语</h3>
        <textarea
          rows={2}
          placeholder="例：AI 问答在考试期间暂时关闭，请独立完成；有疑问联系老师。留空则用默认文案。"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        <div className="row" style={{ marginTop: '0.5rem', alignItems: 'center' }}>
          <button className="ghost" onClick={saveNoteOnly} disabled={saving}>
            {saving ? '保存中…' : '仅保存提示语'}
          </button>
          <span className="spacer" />
          {disabled ? (
            <button className="btn" onClick={() => void apply(false)} disabled={saving} style={{ background: '#1e7a34' }}>
              恢复开启（学生可用）
            </button>
          ) : (
            <button className="btn" onClick={() => void apply(true)} disabled={saving} style={{ background: '#c0392b' }}>
              临时关闭学生 AI 问答
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
