import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import './index.css'
import App from './App.tsx'

// 从知识库子站返回主站时恢复状态栏设置：不延伸到状态栏（保持原生 windowBackground
// 填色，与主站顶栏同色），图标明暗跟随系统主题。仅在 APK 内执行。
if (Capacitor.isNativePlatform()) {
  void (async () => {
    try {
      await StatusBar.setOverlaysWebView({ overlay: false })
      const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
      await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
    } catch { /* 插件不可用时静默降级 */ }
  })()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
