import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sda.vocabulary',
  appName: '9699vocab',
  webDir: 'dist',
  plugins: {
    // 关闭 Capacitor 内置的安全区自动处理。
    // SystemBars 插件在「未声明 viewport-fit=cover」或 WebView 版本较低时，会给 WebView
    // 父容器设置 padding-bottom = 导航栏高度，导致底部出现一条纯色带（windowBackground），
    // 内容无法延伸到导航栏下方 —— 这正是导航栏"透明没彻底"的直接原因。
    // 改为完全自绘：顶部由 InsetPlugin 按页面控制（主站避让 / 子站顶栏铺色），
    // 底部一律不处理，页面内容一直延伸到屏幕底边。
    SystemBars: {
      insetsHandling: 'disable',
    },
  },
};

export default config;
