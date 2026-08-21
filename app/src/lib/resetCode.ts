// 教师公钥：用于校验「一次性重置码」的 ECDSA P-256 签名。
// 对应私钥仅保存在教师本地重置码工具中（不入 GitHub），学生无法伪造重置码。
export const PUBLIC_KEY_B64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERMz_6cU_G1UWaeMF40gIVujKyK2Amb_pz4-kZQ85pgVbxrG2WcBj9VvEISOlV14f3me-ojc9ta5KRzy8e1xicA';

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

let cachedKey: CryptoKey | null = null;

async function publicKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = await crypto.subtle.importKey(
      'spki',
      b64ToBytes(PUBLIC_KEY_B64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  }
  return cachedKey;
}

export type ResetVerifyResult =
  | { ok: true; studentId: string }
  | { ok: false; message: string };

// 校验重置码格式：<学号>.<base64url 签名>，签名覆盖 `reset:<学号>`
export async function verifyResetCode(code: string): Promise<ResetVerifyResult> {
  const idx = code.indexOf('.');
  if (idx <= 0 || idx === code.length - 1) return { ok: false, message: '重置码格式无效。' };
  const studentId = code.slice(0, idx);
  const sigB64 = code.slice(idx + 1);
  if (!studentId) return { ok: false, message: '重置码格式无效。' };
  const msg = new TextEncoder().encode(`reset:${studentId}`);
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64ToBytes(sigB64);
  } catch {
    return { ok: false, message: '重置码签名无效。' };
  }
  try {
    const key = await publicKey();
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sig,
      msg,
    );
    return valid
      ? { ok: true, studentId }
      : { ok: false, message: '重置码签名校验失败（非本课程教师签发）。' };
  } catch {
    return { ok: false, message: '重置码校验失败。' };
  }
}