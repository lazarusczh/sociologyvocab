import { useState, useRef } from 'react';
import { useStore } from '../lib/store';
import type { ImportResult } from '../lib/types';

export default function ImportPanel() {
  const { vocab, importFiles, appendVocab, replaceVocab, clearAll, surnameOverrides, setSurnameOverride, removeSurnameOverride } = useStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  // 待人工确认的非常规学者名，及用户为每个名字填写的「姓氏」草稿
  const [pending, setPending] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

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
    </div>
  );
}
