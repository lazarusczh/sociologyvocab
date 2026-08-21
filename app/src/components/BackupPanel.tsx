import { useRef, useState } from 'react';
import { useStore } from '../lib/store';

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsText(file);
  });
}

export default function BackupPanel() {
  const { exportBackup, importBackup } = useStore();
  const [exportMsg, setExportMsg] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    setExportMsg('');
    const json = await exportBackup();
    if (!json) {
      setExportMsg('导出失败，请重试。');
      return;
    }
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    downloadText(`离线备份_${stamp}.json`, json);
    setExportMsg('已导出备份文件，请妥善保存。');
  };

  const doImport = async () => {
    const files = importRef.current?.files;
    if (!files || files.length === 0) return;
    setImportMsg('');
    setBusy(true);
    try {
      const text = await readFile(files[0]);
      setImportMsg(await importBackup(text));
    } catch (e) {
      setImportMsg(`导入失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  return (
    <div>
      <h1>离线备份</h1>
      <p className="muted">
        你正在离线使用（未登录），学习记录仅保存在本机。导出备份文件可防止数据丢失，也可在换机后导入恢复。
      </p>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3>导出备份</h3>
        <p className="muted" style={{ fontSize: '0.9rem' }}>导出单个 JSON 文件，包含打卡记录、学习进度和错题本。</p>
        <button className="primary" onClick={doExport}>导出备份文件</button>
        {exportMsg && <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--accent)' }}>{exportMsg}</p>}
      </div>

      <div className="card">
        <h3>导入备份</h3>
        <p className="muted" style={{ fontSize: '0.9rem' }}>导入之前导出的备份，可在任意设备恢复（无设备校验）。</p>
        <input ref={importRef} type="file" accept=".json,application/json" />
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <button className="primary" disabled={busy} onClick={doImport}>导入并恢复</button>
        </div>
        {importMsg && <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>{importMsg}</p>}
      </div>
    </div>
  );
}
