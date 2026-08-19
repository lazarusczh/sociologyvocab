import { useState, useRef } from 'react';
import { useStore } from '../lib/store';
import type { ImportResult } from '../lib/types';

export default function ImportPanel() {
  const { vocab, importFiles, appendVocab, replaceVocab, clearAll } = useStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null, mode: 'append' | 'replace') => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await importFiles(Array.from(files));
      if (res.items.length === 0) {
        setError('未能从所选文件中解析到任何词条，请检查文件格式。');
      } else {
        if (mode === 'replace') replaceVocab(res.items);
        else appendVocab(res.items);
        setResult(res);
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
      <h1>管理词库</h1>
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

      <div className="card">
        <h3>导入文件</h3>
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
              <button
                className="danger"
                disabled={busy}
                onClick={() => {
                  if (confirm('确定清空所有词条？此操作不可撤销。')) clearAll();
                }}
              >
                清空词库
              </button>
            </>
          )}
        </div>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
          「追加导入」会按术语去重后添加；「替换全部」会清空原有词库后导入新数据。
        </p>
      </div>

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
            <span className="badge">{result.categories.length} 个主题</span>
          </div>
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

      <div className="card" style={{ marginTop: '0.8rem' }}>
        <h3>导入说明</h3>
        <ul className="muted" style={{ fontSize: '0.9rem', paddingLeft: '1.2rem' }}>
          <li><b>术语表</b>：每个 sheet 一个主题，列为「英文 | 中文 | 英文释义」，首行标题自动跳过。</li>
          <li><b>学者人名表</b>：列为「理论流派 | (头像) | 姓名 | 理论与统计 | 备注」，理论流派自动向下填充，姓名中的换行会被清理。</li>
          <li>所有数据仅保存在本机浏览器/设备中，不会上传到任何服务器。</li>
        </ul>
      </div>
    </div>
  );
}
