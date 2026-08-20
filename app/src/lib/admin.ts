// 教师版 / 学生版开关
// 教师版（本地 dev，或构建时设置 VITE_ADMIN=1）显示「管理词库」入口；
// 学生版（正式 build / APK）不打包该功能，技术学生也无法绕过。
export const IS_ADMIN: boolean =
  import.meta.env.VITE_ADMIN === '1' || import.meta.env.DEV;