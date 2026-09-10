import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import './index.css'
import App from './App.tsx'

// 本地原生插件（android/.../InsetPlugin.java）：控制 WebView 是否避开顶部状态栏
interface InsetPluginApi {
  setTopInsetPadding(options: { enabled: boolean }): Promise<unknown>
}
const Inset = registerPlugin<InsetPluginApi>('InsetPlugin')

// 从知识库子站返回主站时恢复状态栏图标明暗（子站临时改成了浅色图标）。
// 内容是否延伸到系统栏已由原生 MainActivity 统一强制（edge-to-edge），此处不再切换 overlay。
if (Capacitor.isNativePlatform()) {
  // 供 CSS 区分「APK 原生环境」（部分 WebView 不上报 env(safe-area-inset-*)，需按典型值兜底）
  document.documentElement.classList.add('native')
  // 主站：WebView 顶部避开状态栏 —— 状态栏区域由原生 windowBackground 填 surface 色，
  // 与白色顶栏无缝衔接且顶栏保持原高；底部不处理，内容一直延伸到导航栏下方。
  void Inset.setTopInsetPadding({ enabled: true }).catch(() => { /* 插件不可用时忽略 */ })
  void (async () => {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    try {
      await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
    } catch { /* 插件不可用时静默降级 */ }
    try {
      // 老系统（非 edge-to-edge）兜底：状态栏与主站顶栏同色
      await StatusBar.setBackgroundColor({ color: dark ? '#161C24' : '#FFFFFF' })
    } catch { /* ignore */ }
  })()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
