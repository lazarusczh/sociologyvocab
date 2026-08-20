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
  const { identity, exportBackup, importBackup } = useStore();
  const [exportMsg, setExportMsg] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [busy, setBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const resetFileRef = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    setExportMsg('');
    if (!identity) {
      setExportMsg('尚未绑定身份，无法导出。');
      return;
    }
    const json = await exportBackup();
    if (!json) {
      setExportMsg('导出失败，请重试。');
      return;
    }
    downloadText(`打卡备份_${identity.studentId}.json`, json);
    setExportMsg('已导出备份文件，请妥善保存并发送给老师核验。');
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

  const doResetImport = async () => {
    const files = resetFileRef.current?.files;
    if (!files || files.length === 0) {
      setResetMsg('请选择备份文件。');
      return;
    }
    if (!resetCode.trim()) {
      setResetMsg('请输入重置码。');
      return;
    }
    setResetMsg('');
    setBusy(true);
    try {
      const text = await readFile(files[0]);
      setResetMsg(await importBackup(text, resetCode));
      setResetCode('');
    } catch (e) {
      setResetMsg(`恢复失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (resetFileRef.current) resetFileRef.current.value = '';
    }
  };

  return (
    <div>
      <h1>备份与身份</h1>
      <p className="muted">导出打卡记录用于备份与老师核验；换机或清空数据后可用重置码恢复。</p>

      {!identity && (
        <div className="card" style={{ marginBottom: '0.8rem', background: 'var(--warn-bg)', borderColor: 'var(--warn)' }}>
          尚未绑定身份（已跳过），备份导入 / 导出功能已禁用。完成身份绑定后即可使用。
        </div>
      )}

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3>我的身份{identity ? '（已锁定）' : ''}</h3>
        {identity ? (
          <div className="row">
            <div className="stat"><span className="num">{identity.studentId}</span><span className="label">学号</span></div>
            <div className="stat"><span className="num">{identity.name}</span><span className="label">姓名</span></div>
          </div>
        ) : (
          <p className="muted">尚未绑定身份。</p>
        )}
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
          身份一经锁定不可自行修改；如填写有误或需换机，请联系老师获取一次性重置码。
        </p>
      </div>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3>导出备份</h3>
        <p className="muted" style={{ fontSize: '0.9rem' }}>导出单个 JSON 文件，包含打卡记录、学习进度和错题本。</p>
        <button className="primary" onClick={doExport} disabled={!identity}>导出备份文件</button>
        {exportMsg && <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--accent)' }}>{exportMsg}</p>}
      </div>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3>导入备份（同设备）</h3>
        <p className="muted" style={{ fontSize: '0.9rem' }}>在本机恢复之前导出的备份，仅限同一学生、同一设备。</p>
        <input ref={importRef} type="file" accept=".json,application/json" />
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <button className="primary" disabled={busy || !identity} onClick={doImport}>导入并恢复</button>
        </div>
        {importMsg && <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>{importMsg}</p>}
      </div>

      <div className="card">
        <h3>重置码恢复（换机 / 清空）</h3>
        <p className="muted" style={{ fontSize: '0.9rem' }}>
          换机或清空数据导致无法正常导入时，请向老师申请一次性重置码，填写后导入旧备份。
        </p>
        <label className="muted" style={{ fontSize: '0.85rem' }}>
          重置码
          <input value={resetCode} onChange={(e) => setResetCode(e.target.value)} placeholder="粘贴老师发给你的重置码" />
        </label>
        <input ref={resetFileRef} type="file" accept=".json,application/json" style={{ marginTop: '0.6rem' }} />
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <button className="primary" disabled={busy} onClick={doResetImport}>使用重置码导入</button>
        </div>
        {resetMsg && <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>{resetMsg}</p>}
      </div>
    </div>
  );
}