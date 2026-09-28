/**
 * 打卡判定口径的开关（第④步：本地 → 服务端）
 *
 * 为什么需要它：切换判定口径是「最伤信任」的一类改动 —— 一旦服务端数据缺一块，
 *   学生的打卡页会把「明明练了」显示成「未达标」。所以必须留一条**立刻回退**的路。
 *
 * ⚠ 回退代价：改成 `false` 并走一次 `npm run ship`（build + deploy，约 1 分钟）。
 *   之所以不用「Supabase 里放个开关」那种不部署即可切的做法，是因为本次只求
 *   简单可靠；将来若要频繁灰度，再把它换成远端配置。
 *
 * ⚠⚠ 回退时有一处**必须一并处理**：切到服务端之后，补签记录写进的是
 *   `checkin_makeups`（服务端），而本地 `checkin.makeup` 不再更新。
 *   若回退到本地口径，中间这段时间的补签在本地是缺的 ⇒ 需要把这些补签
 *   补回本地（或用 §「已知缺陷期」的方式标注）。所以回退窗口应尽量短。
 *
 * 三个使用点必须共用本开关，否则会出现「打卡页走服务端、打卡弹窗走本地」这类
 * 自相矛盾：`components/StreakCard.tsx`、`components/TeacherCheckPanel.tsx`、
 * `lib/store.tsx` 的 `celebrateCheckIn`。
 */
export const USE_SERVER_CHECKIN = false;
