import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import './index.css'
import App from './App.tsx'

// 从知识库子站返回主站时恢复状态栏图标明暗（子站临时改成了浅色图标）。
// 内容是否延伸到系统栏已由原生 MainActivity 统一强制（edge-to-edge），此处不再切换 overlay。
if (Capacitor.isNativePlatform()) {
  // 供 CSS 区分「APK 原生环境」（子站顶栏安全区兜底用）
  document.documentElement.classList.add('native')
  // 顶部是否避让状态栏、底部是否留白，统一由原生 MainActivity 按 URL 处理，这里不再干预
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
