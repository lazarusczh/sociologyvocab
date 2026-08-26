# 项目备忘（Project Memory）

> 记录尚未实现的功能设想与实现要点，做的时候直接引用即可。

## 通知 / 打卡提醒（未实现）

**目标**：每日提醒用户完成打卡（学习 10 分钟 + 20 题），避免漏签。

**技术方案**
- **APK 端（推荐）**：`@capacitor/local-notifications` 本地通知，可精确调度（Android 底层 `AlarmManager`），App 被划掉/后台也能触发，**无需服务器**。
- **网页端（降级）**：Web `Notification` API，仅页面打开时可靠；页面关闭后无法可靠定时（Service Worker + Push 需要后端，且移动端 Safari 支持差）。

**实现要点**
- 新增「提醒设置」入口：开关 + 提醒时间，存 localStorage + 云端。
- 到点触发时检查当天是否达标：复用 `checkin.ts` 的 `isDayChecked` / `todayKey`，未达标则弹「今日尚未完成打卡」。
- 权限：APK Android 13+ 需 `POST_NOTIFICATIONS` 运行时权限；网页需 `Notification.requestPermission()`。

**优先级**：先做 APK 本地通知 + 每日提醒时间设置，网页端作为降级可后补。

## 教师公告推送 FCM（未实现，较复杂，建议第二阶段）

**目标**：教师发布公告，学生 APK 收到系统级推送通知。

**技术链路**：教师发公告 → 写入 Supabase `announcements` 表 → Supabase Edge Function 监听 insert → 调用 FCM API → 学生设备收到通知。

**成本**：FCM 消息本身免费；Supabase Edge Function 有免费额度。

**实现要点**
- 创建 Firebase 项目，拿 `google-services.json` 配进 Capacitor（Android）。
- 学生 App 用 `@capacitor/push-notifications` 注册，拿到设备 token，存 Supabase（关联 user_id）。
- 新增 `announcements` 表 + 教师端发布公告 UI。
- Edge Function 监听 `announcements` insert，用 FCM HTTP v1 API 向学生 token 广播。
- token 生命周期：注销/换设备时清理失效 token。

**与「打卡提醒」的关系**：打卡提醒是纯客户端本地通知（先做）；公告推送是服务器发起的远程推送（后做），二者互补。

