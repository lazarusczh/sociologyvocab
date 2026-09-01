import { useState, useRef, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import { publishVocab, pullLatestVocab } from '../lib/cloud';
import { saveVocabVersion } from '../lib/storage';
import type { ImportResult } from '../lib/types';

// 通用确认弹层：替代 window.confirm（iframe 预览沙箱中 confirm 被禁用，自定义 UI 在 iframe/APK WebView 中都可靠）
function ConfirmModal({ open, title, body, confirmText = '确认', onCancel, onConfirm }: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmText?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15, 20, 27, 0.45)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
      onClick={onCancel}
    >
      <div className="card" style={{ maxWidth: 440, width: '100%', padding: '1rem' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <div className="muted" style={{ fontSize: '0.9rem', whiteSpace: 'pre-line' }}>{body}</div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.9rem' }}>
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}

export default function ImportPanel() {
  const { vocab, importFiles, appendVocab, replaceVocab, clearAll, surnameOverrides, setSurnameOverride, removeSurnameOverride, unitOrder, vocabDirty, clearVocabDirty } = useStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  // 待人工确认的非常规学者名，及用户为每个名字填写的「姓氏」草稿
  const [pending, setPending] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false); // 发布确认（自定义弹层，替代 window.confirm）
  const [clearOpen, setClearOpen] = useState(false); // 清空词库确认
  const [restoreOpen, setRestoreOpen] = useState(false); // 从云端恢复确认
  const [restoring, setRestoring] = useState(false);

  const handlePublish = async () => {
    if (vocab.length === 0) return;
    setPublishing(true);
    setPublishMsg('');
    try {
      const v = await publishVocab(vocab, undefined, unitOrder);
      setPublishMsg(`已发布 v${v}（${vocab.length} 条词条）`);
      clearVocabDirty();
    } catch (e) {
      setPublishMsg(`发布失败：${(e as Error).message}`);
    } finally {
      setPublishing(false);
    }
  };

  // 从云端最新发布版本恢复本地词库（含逻辑关系）
  const handleRestore = async () => {
    setRestoring(true);
    setPublishMsg('');
    try {
      const pulled = await pullLatestVocab();
      if (!pulled || pulled.data.length === 0) {
        setPublishMsg('云端没有可用词库，或拉取为空。');
        return;
      }
      replaceVocab(pulled.data);
      clearVocabDirty();
      saveVocabVersion(pulled.version);
      setPublishMsg(`已从云端恢复 v${pulled.version}（${pulled.data.length} 条词条），本地词库已覆盖。`);
    } catch (e) {
      setPublishMsg(`恢复失败：${(e as Error).message}`);
    } finally {
      setRestoring(false);
    }
  };

  const finalizeConfirm = () => {
    pending.forEach((name) => {
      const v = (drafts[name] ?? '').trim();
      if (v) setSurnameOverride(name, v);
    });
    setPending([]);
    setDrafts({});
  };

  const handleFiles = async (files: FileList | null, mode: 'append' | 'replace') => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError('');
    setResult(null);
    setPending([]);
    setDrafts({});
    try {
      const res = await importFiles(Array.from(files));
      if (res.items.length === 0) {
        setError('未能从所选文件中解析到任何词条，请检查文件格式。');
      } else {
        if (mode === 'replace') replaceVocab(res.items);
        else appendVocab(res.items);
        setResult(res);
        // 出现非常规格式学者名时，弹出待确认名单（去重且排除已有配置）
        const names = res.suspiciousScholars.filter((n) => !surnameOverrides[n]);
        if (names.length > 0) {
          setPending(names);
          setDrafts(Object.fromEntries(names.map((n) => [n, ''])));
        }
      }
    } catch (e) {
      setError(`导入失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div>
      <p className="muted">
        支持 .xlsx 文件。可一次选择多个文件：主词汇表（多 sheet）与学者人名表（*Name sheet）会自动识别。
      </p>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <div className="stat" style={{ flexDirection: 'row', gap: '1rem' }}>
          <div><span className="num">{vocab.length}</span> <span className="label">当前词条</span></div>
          <div>
            <span className="num">{vocab.filter((i) => i.type === 'term').length}</span>{' '}
            <span className="label">术语</span>
          </div>
          <div>
            <span className="num">{vocab.filter((i) => i.type === 'scholar').length}</span>{' '}
            <span className="label">学者</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3>发布词库</h3>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
          把当前词库（{vocab.length} 条）发布到云端，学生端启动/回首页时自动同步到最新版本。
        </p>
        {vocabDirty && (
          <p style={{ fontSize: '0.85rem', marginTop: '0.3rem', color: 'var(--warn, #d97706)' }}>
            ⚠ 检测到本地有尚未发布过的修改（如理论流派归类等）。这些修改仅保存在本机，学生端暂未同步；发布后才会生效。
          </p>
        )}
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <button className="primary" disabled={publishing || vocab.length === 0} onClick={() => setConfirmOpen(true)}>
            {publishing ? '发布中…' : '发布新版本'}
          </button>
          <button className="ghost" disabled={restoring} onClick={() => setRestoreOpen(true)}>
            {restoring ? '恢复中…' : '从云端恢复'}
          </button>
        </div>
        {publishMsg && <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>{publishMsg}</p>}
      </div>

      <div className="card">
        <h3>批量导入</h3>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          multiple
          disabled={busy}
        />
        <div className="row" style={{ marginTop: '0.8rem' }}>
          <button className="primary" disabled={busy} onClick={() => handleFiles(inputRef.current?.files ?? null, 'append')}>
            {busy ? '导入中…' : '追加导入'}
          </button>
          <button disabled={busy} onClick={() => handleFiles(inputRef.current?.files ?? null, 'replace')}>
            替换全部
          </button>
          {vocab.length > 0 && (
            <>
              <span className="spacer" />
              <button className="danger" disabled={busy} onClick={() => setClearOpen(true)}>
                清空词库
              </button>
            </>
          )}
        </div>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
          「追加导入」会按「术语名 + 考卷 + 主题」去重后添加（同一学者在不同单元可保留多条）；「替换全部」会清空原有词库后导入新数据。
        </p>
      </div>

      {pending.length > 0 && (
        <div className="card" style={{ marginTop: '0.8rem', borderColor: 'var(--accent)' }}>
          <h3>发现 {pending.length} 个非常规格式的学者名，请确认「姓氏」</h3>
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
            这些姓名因含括号本名或全小写（可能是笔名），系统无法可靠判断默写时应认哪个词。
            请在右侧填入「默写时只答它就判对」的写法（如 bell hooks 填 <b>bell hooks</b>）；留空则跳过、保持自动识别。
          </p>
          <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {pending.map((name) => (
              <div key={name} className="row" style={{ alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ minWidth: '16rem', fontFamily: 'monospace' }}>{name}</span>
                <input
                  type="text"
                  placeholder="留空 = 自动识别"
                  value={drafts[name] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [name]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: '0.8rem' }}>
            <button className="primary" onClick={finalizeConfirm}>保存并继续</button>
            <button
              onClick={() => {
                setPending([]);
                setDrafts({});
              }}
            >
              跳过，全部用自动识别
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ marginTop: '0.8rem', borderColor: 'var(--danger)' }}>
          <p style={{ color: 'var(--danger)' }}>{error}</p>
        </div>
      )}

      {result && (
        <div className="card" style={{ marginTop: '0.8rem' }}>
          <h3>导入成功</h3>
          <div className="row">
            <span className="badge success">术语 {result.termCount}</span>
            <span className="badge">学者 {result.scholarCount}</span>
            <span className="badge">{result.papers.length} 个考卷</span>
            <span className="badge">{result.categories.length} 个主题</span>
          </div>
          {result.papers.length > 0 && (
            <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
              考卷：{result.papers.join('、')}
            </p>
          )}
          {result.categories.length > 0 && (
            <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
              主题：{result.categories.join('、')}
            </p>
          )}
          {result.warnings.length > 0 && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary className="muted" style={{ fontSize: '0.85rem', cursor: 'pointer' }}>
                警告信息 ({result.warnings.length})
              </summary>
              <ul style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {Object.keys(surnameOverrides).length > 0 && (
        <div className="card" style={{ marginTop: '0.8rem' }}>
          <h3>已指定的特殊姓氏（{Object.keys(surnameOverrides).length}）</h3>
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
            这些是你手动指认过「姓氏」的学者名。可删除某条以恢复自动识别。
          </p>
          <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {Object.entries(surnameOverrides).map(([term, surname]) => (
              <div key={term} className="row" style={{ alignItems: 'center', gap: '0.6rem' }}>
                <span style={{ minWidth: '16rem', fontFamily: 'monospace' }}>{term}</span>
                <span className="badge" style={{ marginRight: 'auto' }}>→ {surname}</span>
                <button onClick={() => removeSurnameOverride(term)}>删除</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: '0.8rem' }}>
        <h3>导入说明</h3>
        <ul className="muted" style={{ fontSize: '0.9rem', paddingLeft: '1.2rem' }}>
          <li><b>术语表</b>：每个 sheet 一个主题，列为「英文 | 中文 | 英文释义」，首行标题自动跳过。</li>
          <li><b>学者人名表</b>：列为「理论流派 | (头像) | 姓名 | 理论与统计 | 备注」，理论流派自动向下填充，姓名中的换行会被清理。</li>
          <li>所有数据仅保存在本机浏览器/设备中，不会上传到任何服务器。</li>
        </ul>
      </div>

      {/* 自定义确认弹层（发布 / 清空）——iframe 预览沙箱中 window.confirm 失效，统一改用自定义 UI */}
      <ConfirmModal
        open={confirmOpen}
        title="确定发布词库到云端？"
        body={
          <>
            将把当前 {vocab.length} 条词条发布为新版本，学生端启动/回首页时会自动同步到该版本。
            {vocabDirty && '\n\n检测到本地有尚未发布过的修改（含逻辑关系/流派归类等），发布后学生端将同步到这些内容。'}
            {'\n\n发布后如发现需要调整，可再次编辑并发布新版本。'}
          </>
        }
        confirmText="确认发布"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); handlePublish(); }}
      />
      <ConfirmModal
        open={clearOpen}
        title="清空所有词条？"
        body="确定清空所有词条？此操作不可撤销，清空后需重新导入。"
        confirmText="确认清空"
        onCancel={() => setClearOpen(false)}
        onConfirm={() => { setClearOpen(false); clearAll(); }}
      />
      <ConfirmModal
        open={restoreOpen}
        title="从云端恢复词库？"
        body="将从云端最新发布版本拉取并覆盖本地词库（含逻辑关系）。发布之后在本地新增的内容会丢失，请确认。"
        confirmText="确认恢复"
        onCancel={() => setRestoreOpen(false)}
        onConfirm={() => { setRestoreOpen(false); handleRestore(); }}
      />
    </div>
  );
}
