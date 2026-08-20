import { useState } from 'react';
import { useStore } from '../lib/store';

export default function IdentityGate() {
  const { setIdentity, skipIdentity } = useStore();
  const [studentId, setStudentId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    const sid = studentId.trim();
    const nm = name.trim();
    if (!sid || !nm) {
      setError('请完整填写学号和姓名。');
      return;
    }
    setIdentity(sid, nm);
  };

  return (
    <div className="gate">
      <form
        className="card gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="big">🪪</div>
        <h1>首次使用 · 绑定身份</h1>
        <p className="muted">
          填写学号和姓名后将<b>锁定不可修改</b>，用于防止打卡记录被他人冒名顶替。请务必填写本人真实信息。
        </p>
        <label>
          学号
          <input
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            placeholder="例如：20240101"
            autoFocus
          />
        </label>
        <label>
          姓名
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="填写真实姓名"
          />
        </label>
        {error && <p className="gate-error">{error}</p>}
        <button className="primary" type="submit">锁定并开始</button>
        <button className="ghost" type="button" onClick={skipIdentity} style={{ marginTop: '0.5rem' }}>
          跳过，暂不绑定
        </button>
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
          跳过后备份导入 / 导出功能将被禁用，下次打开应用会再次提醒绑定。
        </p>
      </form>
    </div>
  );
}