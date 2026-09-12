// 主站与 skill 子站**共用**的 Supabase 访问策略：直连优先 + 同源代理兜底。
//
// 背景（详见 KNOWN_ISSUES 第 4 条）：部分设备（信任库较旧的 Android）**不信任** Supabase
// 主机的证书——那条链的根是 2021 年后新增的 `GlobalSign Root R46`。浏览器遇到证书不受信
// 可以手动"继续访问"，WebView 没有这个选项，于是**任何未经此包装的 Supabase 客户端**
// 都会在那些设备上全线 `Failed to fetch`（2026-09-13 主站修好后，skill 子站因为自建了
// 独立客户端而漏网，在平板上一直加载不出来——所以这个包装必须两边共用）。
//
// 策略：默认直连原主机（大陆延迟最低、路径最短）；一旦某次请求出现**网络层失败**
//（fetch 只在"请求没拿到响应"时才 reject：DNS/连接/TLS 证书/被浏览器策略拦截；
//  HTTP 4xx/5xx 属于正常响应、不会走到 catch），就说明该设备大概率不信任证书 →
// 记住状态，之后全部改走自家 Worker 的同源代理 `/sb/*`（Cloudflare 证书任何安卓版本都受信）。
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const isAppShell =
  typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.protocol === 'capacitor:');
// 网页端用当前站点自己的 /sb（同一台 Worker，workers.dev 预览同样可用）；APK 与本地 dev 用正式域名
const proxyBase = isAppShell
  ? 'https://9699vocab.cn/sb'
  : typeof location !== 'undefined'
    ? `${location.origin}/sb`
    : '';

let viaProxy = false;

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function toProxyUrl(url: string): string {
  return url.startsWith(SUPABASE_URL) ? proxyBase + url.slice(SUPABASE_URL.length) : url;
}

export const resilientFetch: typeof fetch = async (input, init) => {
  if (viaProxy) return fetch(toProxyUrl(urlOf(input)), init);
  try {
    return await fetch(input, init);
  } catch (e) {
    // 只有"请求没拿到响应"才会走到这里：证书不受信、DNS/连接超时、被浏览器策略拦截
    viaProxy = true;
    console.warn('[supabase] 直连失败，已改用同源代理 /sb：', (e as Error)?.message ?? e);
    return fetch(toProxyUrl(urlOf(input)), init);
  }
};

/** 当前是否已确定要走同源代理（供 UI 提示用）。 */
export function isUsingProxy(): boolean {
  return viaProxy;
}

// ===== 启动预热：把"直连失败 → 改走代理"的代价与启动过程重叠 =====
// 不预热的话，代价会落在**第一个真实业务请求**上：用户先等一次失败、再等一次回退成功的重试，
// 首屏明显变慢，而且这段时间界面容易退化成"未登录/空白"的样子（会被误认为掉登录）。
// 探测只判断**直连是否可达**：HTTP 4xx/5xx 属于"可达"，不会触发回退（只有请求拿不到响应才算失败）。
let warmedUp = false;
function warmUpSupabaseRoute(): void {
  if (warmedUp) return;
  warmedUp = true;
  void fetch(`${SUPABASE_URL}/auth/v1/health`, { cache: 'no-store' }).catch(() => {
    viaProxy = true;
    console.warn('[supabase] 直连不可达（证书/网络），已在预热阶段切到同源代理 /sb');
  });
}
warmUpSupabaseRoute();
