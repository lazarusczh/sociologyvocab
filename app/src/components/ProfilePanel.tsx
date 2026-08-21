import { useState } from 'react';
import { useStore } from '../lib/store';

// 个人页：显示当前登录账号，提供退出登录、修改密码等功能。
export default function ProfilePanel() {
  const { authUser, signOut, changePassword } = useStore();
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [pwMsg, setPwMsg] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  const [busy, setBusy] = useState(false);

  if (!authUser) return null;

  const submitPassword = async () => {
    setPwMsg({ text: '', error: false });
    if (pw.length < 6) {
      setPwMsg({ text: '密码至少 6 位。', error: true });
      return;
    }
    if (pw !== pw2) {
      setPwMsg({ text: '两次输入的密码不一致。', error: true });
      return;
    }
    setBusy(true);
    const err = await changePassword(pw);
    setBusy(false);
    if (err) {
      setPwMsg({ text: err, error: true });
    } else {
      setPwMsg({ text: '密码已修改，下次登录请使用新密码。', error: false });
      setPw('');
      setPw2('');
    }
  };

  return (
    <div>
      <h1>我的账号</h1>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3>登录信息</h3>
        <div className="row" style={{ marginTop: '0.4rem' }}>
          <div className="stat"><span className="num">{authUser.name || '—'}</span><span className="label">姓名</span></div>
          <div className="stat"><span className="num" style={{ fontSize: '1.05rem', overflowWrap: 'anywhere' }}>{authUser.email}</span><span className="label">邮箱</span></div>
        </div>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
          学习记录已自动同步到云端，换机后登录同一邮箱即可恢复。
        </p>
      </div>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3>退出登录</h3>
        <p className="muted" style={{ fontSize: '0.9rem' }}>
          退出后回到登录界面；本地学习记录会保留，下次登录同一邮箱仍可恢复。
        </p>
        <button className="primary" onClick={() => signOut()} style={{ marginTop: '0.4rem' }}>
          退出登录
        </button>
      </div>

      <div className="card">
        <button
          type="button"
          className="collapse-head"
          aria-expanded={pwOpen}
          onClick={() => setPwOpen((v) => !v)}
        >
          <span>修改密码</span>
          <span className="collapse-caret">{pwOpen ? '▾' : '▸'}</span>
        </button>
        {pwOpen && (
          <div style={{ marginTop: '0.6rem' }}>
            <p className="muted" style={{ fontSize: '0.9rem' }}>
              设置新的登录密码（至少 6 位）。
            </p>
            <label className="muted" style={{ fontSize: '0.85rem', display: 'block', marginTop: '0.6rem' }}>
              新密码
              <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="至少 6 位" />
            </label>
            <label className="muted" style={{ fontSize: '0.85rem', display: 'block', marginTop: '0.6rem' }}>
              再次输入新密码
              <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="再次输入" />
            </label>
            <button className="primary" onClick={submitPassword} disabled={busy} style={{ marginTop: '0.6rem' }}>
              {busy ? '提交中…' : '修改密码'}
            </button>
            {pwMsg.text && (
              <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: pwMsg.error ? 'var(--danger)' : 'var(--success)' }}>
                {pwMsg.text}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
