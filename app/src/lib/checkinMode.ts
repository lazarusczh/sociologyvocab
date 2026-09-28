/**
 * 打卡判定口径的开关（第④步：本地 → 服务端）
 *
 * 为什么需要它：切换判定口径是「最伤信任」的一类改动 —— 一旦服务端数据缺一块，
 *   学生的打卡页会把「明明练了」显示成「未达标」。所以必须留一条**立刻回退**的路。
 *
 * ---------------------------------------------------------------------------
 * 为什么做成「按时间自动切换」而不是一个布尔常量
 *
 * 常量会被 vite 编译进 bundle ⇒ 改它必须重新 build + deploy ⇒ 想在半夜生效就得
 * **半夜 ship**。而 `npm run ship` 失败后不能简单重跑（第二次 build 会让
 * `BUILD_VERSION` 分叉、APK 内嵌 `version.json` 与线上不一致），半夜无人处理反而更麻烦。
 *
 * 改成**运行时判断**之后：**白天 ship（有人在场、可当场验证）**，到点自动生效。
 * 学生下次打开页面即生效 —— 组件不需要实时翻转。
 *
 * ⚠ 「切换时刻」与「XP 起算日」是两件事，不要混：
 *   · XP 起算日 = 2026-09-30 ⇒ 决定**哪些事件计入 XP**（服务端 `get_xp_summary` 过滤）；
 *   · 判定切换时刻 = 下方 `SWITCH_AT_MS` ⇒ 决定**学生何时看到服务端口径**。
 *   09-30 全天学生仍走本地判定（本地口径一直准确），而 09-30 的练习照常计入 XP，两者不冲突。
 *
 * ⚠ 局限（已知并接受）：`Date.now()` 是**客户端时钟**，学生可以改它提前打开服务端口径。
 *   但影响有限 —— 他只能改**自己看到的显示口径**，服务端判定与算分是权威且不可篡改的。
 *   若要更严需每次问服务端时钟（多一次往返），不为这点收益付那个成本。
 *
 * ⚠ 回退：把 `FORCE_SERVER_CHECKIN` 设为 `false` 并走一次 `npm run ship`（约 1 分钟）。
 *   ⚠⚠ 回退时有一处**必须一并处理**：切到服务端之后，补签记录写进的是
 *   `checkin_makeups`（服务端），而本地 `checkin.makeup` 不再更新。
 *   若回退到本地口径，中间这段时间的补签在本地是缺的 ⇒ 需要把它们补回本地。
 *   所以回退窗口应尽量短。
 *
 * 三个使用点必须共用本开关，否则会出现「打卡页走服务端、打卡弹窗走本地」这类
 * 自相矛盾：`components/StreakCard.tsx`、`components/TeacherCheckPanel.tsx`、
 * `lib/store.tsx` 的 `celebrateCheckIn`。
 * ---------------------------------------------------------------------------
 */

/** 切换时刻：**2026-09-30 23:59（北京时间）** = 15:59 UTC。
 *  选在当天最后一分钟，是为了让 09-30 全天都走已充分验证的本地口径，
 *  同时确保 09-30 的事件都已入库（客户端 72 小时队列窗口远在此之后）。 */
const SWITCH_AT_MS = Date.UTC(2026, 8, 30, 15, 59, 0);

/**
 * 手动覆盖：`null` = 按时间自动（生产默认）；`true` / `false` = 强制。
 *
 * 用途有二：① 开发时强制走服务端验证改动，不必改系统时间；
 * ② 出问题时的**紧急回退** —— 设为 `false` 后 ship 一次即可。
 */
export const FORCE_SERVER_CHECKIN: boolean | null = null;

/**
 * 本地开发覆盖（**只在 `import.meta.env.DEV` 下生效，生产构建里整段被摇掉**）。
 *
 * 为什么需要：切换时刻在 09-30 23:59，而在此之前本地预览看不到任何切换后的界面
 *   （等级卡片、服务端打卡口径）。若为此临时把 `FORCE_SERVER_CHECKIN` 改成 `true`，
 *   一旦这个临时状态被提交并 ship，就会**提前对所有学生生效** —— 那是不可接受的。
 *   ⇒ 用只有开发构建才存在的分支来预览，生产构建里这段代码不存在，学生无法触发。
 *
 * 控制台可切换：`localStorage.setItem('xp:serverCheckin','0')` 看切换前的界面；
 *   `'1'` 看切换后；`removeItem` 回到默认（开）。
 */
function devOverride(): boolean | null {
  if (!import.meta.env.DEV) return null;
  try {
    const v = localStorage.getItem('xp:serverCheckin');
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    // 隐私模式等拿不到 localStorage：忽略，走默认
  }
  return true; // 开发环境默认按"已切换"预览
}

/** 此刻是否应走服务端打卡口径。 */
export function isServerCheckinEnabled(now: number = Date.now()): boolean {
  const dev = devOverride();
  if (dev !== null) return dev;
  if (FORCE_SERVER_CHECKIN !== null) return FORCE_SERVER_CHECKIN;
  return now >= SWITCH_AT_MS;
}
