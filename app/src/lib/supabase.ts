import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// 阿里云 Supabase 兼容版（AnalyticDB for PostgreSQL）连接信息
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// anon 密钥是公开密钥，前端直接使用没问题；service_role 密钥绝不进入前端。

// ===== 直连优先 + 同源代理兜底（详见 KNOWN_ISSUES 第 4 条）=====
// 背景：部分设备（信任库较旧的 Android）**不信任** Supabase 主机的证书——那条链的根是
// 2021 年后新增的 GlobalSign Root R46。浏览器遇到证书不受信可以手动"继续访问"，WebView 没有
// 这个选项，于是 App 与这些设备上的登录/同步全部报 Failed to fetch。
// 策略：默认直连原主机（大陆延迟最低、路径最短）；一旦某次请求出现**网络层失败**
//（fetch 只在"请求没拿到响应"时才 reject：DNS/连接/TLS 证书/被拦截；HTTP 4xx/5xx 属于正常响应、
// 不会走到 catch），就说明该设备大概率不信任证书 → 记住状态，之后全部改走自家 Worker 的
// 同源代理 /sb/*（Cloudflare 证书任何安卓版本都受信）。这样正常设备零影响，中招设备自愈。
const isAppShell =
  typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.protocol === 'capacitor:');
// 网页端用当前站点自己的 /sb（同一台 Worker，workers.dev 预览同样可用）；APK 与本地 dev 用正式域名
const proxyBase = isAppShell ? 'https://9699vocab.cn/sb' : (typeof location !== 'undefined' ? `${location.origin}/sb` : '');

let viaProxy = false;

function toProxyUrl(url: string): string {
  return url.startsWith(supabaseUrl) ? proxyBase + url.slice(supabaseUrl.length) : url;
}

const resilientFetch: typeof fetch = async (input, init) => {
  if (viaProxy) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(toProxyUrl(url), init);
  }
  try {
    return await fetch(input, init);
  } catch (e) {
    // 只有网络层失败会走到这里：证书不受信、DNS/连接超时、被浏览器策略拦截
    viaProxy = true;
    console.warn('[supabase] 直连失败，已改用同源代理 /sb：', (e as Error)?.message ?? e);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(toProxyUrl(url), init);
  }
};

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: resilientFetch },
});
