// 共享鉴权：Supabase access token 校验 + 角色判定
// 供子站 /skill-api/*（登录即可）与主站 /app-api/*（强制 teacher/developer）共用。
// 逻辑与 worker.ts 原有实现完全一致（原样搬出，便于两套命名空间共用）。

export interface AuthEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

/** 校验 Supabase access token：调 auth/v1/user，返回用户 id；无效返回 null */
export async function verifyUser(token: string, env: AuthEnv): Promise<string | null> {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { id?: string };
    return body.id ?? null;
  } catch {
    return null;
  }
}

/** 取角色列表（user_roles 表，RLS 允许本人读自己） */
export async function rolesOf(userId: string, token: string, env: AuthEnv): Promise<string[]> {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(userId)}`,
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as { role?: string }[];
    return rows.map((r) => r.role ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 从 Authorization 头解析 token。
 * 注意：查询失败时 rolesOf 返回 []，也就是**默认拒绝**（主站是教师专用，
 * 与子站"读取失败宁可放行"的策略相反：这里失败必须挡住，避免越权）。
 */
export function bearer(request: Request): string {
  const auth = request.headers.get('Authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

export async function isTeacherOrDeveloper(userId: string, token: string, env: AuthEnv): Promise<boolean> {
  const roles = await rolesOf(userId, token, env);
  return roles.includes('teacher') || roles.includes('developer');
}

/**
 * AI 门禁：教师临时关闭期间，**学生**不可用（teacher/developer 不受影响）。
 * 返回 null = 放行；否则返回学生可见的提示语。
 * 读取失败/角色查询异常时**不拦截**（宁可放行，不让系统错误误伤学生）。
 * 两套命名空间共用：/skill-api/*（子站问答）与 /app-api/*（主站 AI）。
 * simulateStudent=true：跳过角色豁免，让 teacher/developer 以"学生身份"被判定（自测用）。
 */
export async function aiGateForbidden(
  userId: string,
  token: string,
  env: AuthEnv,
  simulateStudent = false,
): Promise<string | null> {
  const headers = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
  try {
    if (!simulateStudent) {
      const rolesRes = await fetch(`${env.SUPABASE_URL}/rest/v1/user_roles?select=role&user_id=eq.${userId}`, {
        headers,
      });
      if (!rolesRes.ok) return null;
      const roles = (await rolesRes.json()) as { role?: string }[];
      if (roles.some((r) => r.role === 'teacher' || r.role === 'developer')) return null;
    }
    const gateRes = await fetch(`${env.SUPABASE_URL}/rest/v1/ai_gate?select=disabled_at,note&id=eq.1`, { headers });
    if (!gateRes.ok) return null;
    const gate = (await gateRes.json()) as { disabled_at?: string | null; note?: string }[];
    const row = gate[0];
    if (row && row.disabled_at) return row.note?.trim() || 'AI 问答已由老师暂时关闭。';
    return null;
  } catch {
    return null;
  }
}
