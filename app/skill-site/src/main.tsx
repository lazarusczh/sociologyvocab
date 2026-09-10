import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import './index.css'
import App from './App.tsx'

// APK（Capacitor）里：子站移动顶栏是品牌深蓝，让内容延伸到状态栏下，
// 顶栏自身用 env(safe-area-inset-top) 把深蓝铺满状态栏区域，同时把状态栏图标改成浅色，
// 这样状态栏与顶栏始终同色（Android 15 强制 edge-to-edge 下也成立）。
// 浏览器里不执行（没有原生状态栏）。
if (Capacitor.isNativePlatform()) {
  // 供 CSS 区分「APK 原生环境」：部分 WebView 不上报 env(safe-area-inset-*)，
  // 需要按状态栏典型高度兜底，保证顶栏深蓝能铺到状态栏区域
  document.documentElement.classList.add('native')
  void (async () => {
    try {
      await StatusBar.setStyle({ style: Style.Dark })   // 深蓝顶栏 → 状态栏用浅色图标
    } catch { /* 插件不可用时静默降级 */ }
    try {
      // 老系统（非 edge-to-edge）兜底：状态栏取顶栏深蓝；Android 15+ 由顶栏自绘铺色，失败无妨
      await StatusBar.setBackgroundColor({ color: '#10243e' })
    } catch { /* ignore */ }
  })()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
