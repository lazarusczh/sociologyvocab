// 自家 API（`/app-api/*`）的地址解析。
//
// **为什么需要这一层（2026-09-21 修 APK bug）**：
//   APK 用 Capacitor 打包，WebView 跑在 `https://localhost`。**相对路径会以那个 origin 解析** ——
//   于是 `fetch('/app-api/mb/write')` 变成请求 `https://localhost/app-api/mb/write`，
//   而那里没有我们的服务，请求根本到不了 Worker。
//   网页端的 origin 就是站点本身，相对路径天然正确，所以一直没暴露这个问题 ——
//   表现为「网页端正常、APK 报错」。教师实测：APK 上成绩同步失败。
//
// 同一个坑此前在 `/sb`（Supabase 同源代理）上已经踩过并处理，
// 见 `supabaseFetch.ts` 的 `proxyBase`；这里是把它推广到自家 API。
//
// 判据与 `supabaseFetch.ts` **保持一致**，改一处要同步另一处：
//   hostname 是 localhost，或协议是 capacitor: ⇒ 视为原生外壳（APK / 本地 dev 壳）。
// 唯一的例外是下面的 LOCAL_API（仅 dev、仅 /app-api）：它把这条判据在本地关掉，
// 好让本地页面打到本机 Worker 而不是线上。supabaseFetch 不需要这个例外。
const PROD_ORIGIN = 'https://9699vocab.cn';

/**
 * **本地联调开关**（只在 dev 下有意义）：`VITE_LOCAL_API=1` 时把 `/app-api` 留成相对路径，
 * 好让 `vite.config.ts` 把它代理到**本机 Worker**（`npx wrangler dev`）。
 *
 * 为什么需要它：不设这个开关时，下面会把 localhost 当成"原生外壳" ⇒ `/app-api` 指向正式域名
 * —— 本地页面点「同步到 ManageBac」实际打的是**线上那份 Worker**，本地刚改的 Worker 代码验不到。
 * 生产构建里这个变量不存在 ⇒ 恒为 false，行为不变。
 */
const LOCAL_API = import.meta.env.VITE_LOCAL_API === '1';

const isAppShell =
  !LOCAL_API &&
  typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.protocol === 'capacitor:');

/**
 * 把站点内路径（`/app-api/xxx`）解析成当前环境可用的地址。
 *
 * - **网页端**：原样返回相对路径 —— 保留 workers.dev 预览、自定义域名等同源形态，
 *   不把线上域名写死进去。
 * - **原生外壳（APK）**：拼正式域名 —— 否则会打到 `https://localhost` 上。
 *
 * 非 `/` 开头的（已是绝对地址或第三方 URL）原样返回，不做处理。
 */
export function apiUrl(path: string): string {
  if (!path.startsWith('/')) return path;
  if (isAppShell) return PROD_ORIGIN + path;
  return path;
}
