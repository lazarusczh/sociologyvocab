import { useEffect, useRef, useState } from 'react';
import { PUBLIC_KEY_B64 } from '../lib/resetCode';

// 教师重置码工具：给学生换机 / 清空数据后签发「一次性重置码」。
// 私钥仅保存在本机浏览器 localStorage（key = reset_teacher_private_key_v1），
// 与 reset-tool/index.html 共用同一存储键，两边可互相读取私钥。

const LS_KEY = 'reset_teacher_private_key_v1';
const ALGO = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

interface KeyPayload {
  pkcs8: string;
  publicSpki: string;
}

function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuf(b64: string): Uint8Array<ArrayBuffer> {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function loadKey(): KeyPayload | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as KeyPayload) : null;
  } catch {
    return null;
  }
}

function saveKey(payload: KeyPayload): void {
  localStorage.setItem(LS_KEY, JSON.stringify(payload));
}

function downloadText(filename: string, text: string): void {
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

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走 fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

export default function ResetTool() {
  const [key, setKey] = useState<KeyPayload | null>(() => loadKey());
  const [sid, setSid] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setKey(loadKey());
  }, []);

  // 本机私钥对应的公钥是否与 App 内置公钥一致（不一样则签出的码学生端无法验证）
  const matched = !!key && key.publicSpki === PUBLIC_KEY_B64;

  async function doGenerate() {
    if (loadKey()) {
      const ok = confirm('本机已有私钥。重新生成会覆盖旧私钥，之后旧公钥签发的重置码将全部失效。确定重新生成吗？');
      if (!ok) return;
    }
    const pair = await crypto.subtle.generateKey(ALGO, true, ['sign', 'verify']);
    const publicSpki = bufToB64url(await crypto.subtle.exportKey('spki', pair.publicKey));
    const pkcs8 = bufToB64url(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const payload: KeyPayload = { pkcs8, publicSpki };
    saveKey(payload);
    setKey(payload);
    setCode('');
    setMsg({ text: '已生成新密钥。请将下方公钥同步到 App 内置公钥，并导出私钥文件备份。', error: false });
  }

  async function doSign() {
    if (!key) {
      setMsg({ text: '请先生成或导入私钥。', error: true });
      return;
    }
    const id = sid.trim();
    if (!id) {
      setMsg({ text: '请输入学生学号。', error: true });
      return;
    }
    if (id.includes('.')) {
      setMsg({ text: '学号不能包含小数点「.」。', error: true });
      return;
    }
    const priv = await crypto.subtle.importKey('pkcs8', b64urlToBuf(key.pkcs8), ALGO, false, ['sign']);
    const msgBytes = new TextEncoder().encode(`reset:${id}`);
    const sig = await crypto.subtle.sign(SIGN, priv, msgBytes);
    setCode(`${id}.${bufToB64url(sig)}`);
    setMsg({ text: `已生成重置码，复制后发给学号「${id}」的学生。`, error: false });
  }

  function doExport() {
    if (!key) {
      setMsg({ text: '还没有私钥，请先生成。', error: true });
      return;
    }
    const payload = {
      note: '教师私钥，务必妥善备份，切勿上传 GitHub 或公开网盘',
      pkcs8: key.pkcs8,
      publicSpki: key.publicSpki,
    };
    downloadText('teacher-private-key.json', JSON.stringify(payload, null, 2));
    setMsg({ text: '已导出 teacher-private-key.json，请多处备份。', error: false });
  }

  function doImportFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(String(reader.result));
        if (!p.pkcs8 || !p.publicSpki) throw new Error('bad');
        const payload: KeyPayload = { pkcs8: p.pkcs8, publicSpki: p.publicSpki };
        saveKey(payload);
        setKey(payload);
        setCode('');
        setMsg({ text: '私钥已导入。', error: false });
      } catch {
        setMsg({ text: '导入失败：不是有效的私钥文件。', error: true });
      }
    };
    reader.readAsText(file);
  }

  async function copy(value: string) {
    const ok = await copyText(value);
    setMsg(ok ? { text: '已复制到剪贴板。', error: false } : { text: '复制失败，请手动选中复制。', error: true });
  }

  return (
    <div>
      <p className="muted">
        给学生换机 / 清空数据后签发「一次性重置码」。私钥只保存在本机浏览器，请务必导出备份；公钥需与 App 内置公钥保持一致，否则签出的码学生端无法通过。
      </p>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3>1. 密钥</h3>
        {key ? (
          matched ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--success)' }}>本机私钥与 App 内置公钥一致，可直接签发。</p>
          ) : (
            <p style={{ fontSize: '0.85rem', color: 'var(--warn)' }}>本机公钥与 App 内置公钥不一致，请将下方公钥同步到 App（联系开发者更新后重建）再签发。</p>
          )
        ) : (
          <p className="muted" style={{ fontSize: '0.85rem' }}>尚未初始化，请先「生成新密钥」。</p>
        )}
        <div className="row" style={{ marginTop: '0.4rem' }}>
          <button className="primary" onClick={doGenerate}>{key ? '重新生成密钥' : '生成新密钥'}</button>
        </div>
        <div style={{ marginTop: '0.6rem' }}>
          <label className="muted" style={{ fontSize: '0.85rem' }}>本机公钥（交给开发者同步到 App）</label>
          <textarea readOnly value={key?.publicSpki ?? ''} rows={2} style={{ marginTop: '0.25rem' }} />
          <button disabled={!key} onClick={() => copy(key!.publicSpki)} style={{ marginTop: '0.4rem' }}>复制公钥</button>
        </div>
        <div style={{ marginTop: '0.6rem' }}>
          <label className="muted" style={{ fontSize: '0.85rem' }}>App 内置公钥（学生端验证用）</label>
          <textarea readOnly value={PUBLIC_KEY_B64} rows={2} style={{ marginTop: '0.25rem', opacity: 0.7 }} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: '0.8rem' }}>
        <h3>2. 签发重置码</h3>
        <div className="row" style={{ gap: '0.6rem' }}>
          <input
            type="text"
            placeholder="输入学生学号，例如 20240001"
            value={sid}
            onChange={(e) => setSid(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={doSign} disabled={!key}>生成重置码</button>
        </div>
        {code && (
          <div style={{ marginTop: '0.6rem' }}>
            <label className="muted" style={{ fontSize: '0.85rem' }}>重置码（复制发给对应学生）</label>
            <textarea readOnly value={code} rows={2} style={{ marginTop: '0.25rem' }} />
            <button onClick={() => copy(code)} style={{ marginTop: '0.4rem' }}>复制重置码</button>
          </div>
        )}
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>重置码只对输入的学号有效、用一次即作废，别人拿到也用不了。</p>
      </div>

      <div className="card">
        <h3>3. 私钥备份</h3>
        <div className="row" style={{ gap: '0.6rem' }}>
          <button onClick={doExport} disabled={!key}>导出私钥文件</button>
          <button onClick={() => fileRef.current?.click()} disabled={!key}>导入私钥文件</button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) doImportFile(f);
            e.target.value = '';
          }}
        />
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
          私钥是老师的「专属印章」，一旦丢失就再也无法签发重置码。请导出文件后多处保存（本地、U 盘等，切勿放公开网盘）。
        </p>
      </div>

      {msg.text && (
        <p style={{ marginTop: '0.6rem', fontSize: '0.9rem', color: msg.error ? 'var(--danger)' : 'var(--success)' }}>
          {msg.text}
        </p>
      )}
    </div>
  );
}