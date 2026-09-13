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
