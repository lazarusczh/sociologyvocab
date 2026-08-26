import { useState } from 'react';
import { useStore } from '../lib/store';

export default function IdentityGate() {
  const { signIn, signUp, skipIdentity } = useStore();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const em = email.trim();
    const pw = password;
    if (!em || !pw) {
      setError('请填写邮箱和密码。');
      return;
    }
    setBusy(true);
    setError('');
    const err = mode === 'signin'
      ? await signIn(em, pw)
      : await signUp(em, pw, name.trim());
    setBusy(false);
    if (err) setError(err);
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
        <h1>{mode === 'signin' ? '登录' : '注册'}</h1>
        <p className="muted">
          {mode === 'signin'
            ? '用学校邮箱登录，学习记录会自动同步到云端，换设备也能找回。'
            : '用学校邮箱注册，设置自己的密码。注册后即可登录，无需邮箱验证。'}
        </p>

        <div className="gate-tabs">
          <button
            type="button"
            className={mode === 'signin' ? 'active' : ''}
            onClick={() => { setMode('signin'); setError(''); }}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => { setMode('signup'); setError(''); }}
          >
            注册
          </button>
        </div>

        {mode === 'signup' && (
          <label>
            姓名
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="填写英文名+姓氏拼音（便于老师核验）"
            />
          </label>
        )}
        <label>
          邮箱
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="学校邮箱"
            autoFocus
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 位"
          />
        </label>

        {error && <p className="gate-error">{error}</p>}
        {mode === 'signin' && (
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
            忘记密码？请联系老师重置为临时密码，登录后可在「我的账号」里改回自己的密码。
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? '请稍候…' : mode === 'signin' ? '登录' : '注册并登录'}
        </button>
        <button className="ghost" type="button" onClick={skipIdentity} style={{ marginTop: '0.5rem' }}>
          跳过，离线使用
        </button>
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
          离线使用的记录仅保存在本机、不会被老师统计；备份导入 / 导出功能也将被禁用。
        </p>
      </form>
    </div>
  );
}
