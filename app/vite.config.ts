import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 本次构建的版本号。必须「一处生成、两处使用」，保证两者严格一致：
//   1) 注入进 JS（__APP_VERSION__）——回答「我这份 JS 是哪个版本」
//   2) 写入 dist/version.json   ——回答「服务器当前是哪个版本」
// 前端比对这两者，才能识别出「页面实际跑的是旧 JS」。若改回「以加载时的服务器版本为基准」，
// 遇到旧 HTML 被缓存 / bfcache 恢复 / 离线启动等情况会永远不提示。
const BUILD_VERSION = String(Date.now());

// 构建时生成 version.json：前端轮询该文件检测新版本（用于提示用户刷新到最新版）
function versionJson(): Plugin {
  return {
    name: 'gen-version-json',
    apply: 'build',
    closeBundle() {
      const outDir = join(import.meta.dirname, 'dist');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'version.json'), JSON.stringify({ version: BUILD_VERSION }), 'utf8');
      console.log(`[version] ${BUILD_VERSION}`);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), versionJson()],
  // 注入构建版本号，供 VersionCheck 与服务器版本比对（类型声明见 src/vite-env.d.ts）
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  server: {
    // 文件监视设置（踩坑记录 2026-09-22）：
    //   app/android 是指向 C:\vocab-build\android 的 junction（见 CODEBUDDY.md）。在 OneDrive 路径下，
    //   chokidar 默认「跟随符号链接」会去 stat 这个 junction 的目标，报 UNKNOWN(-4094) 并让 vite 进程直接崩掉
    //   （表现为 dev server 起来 1 秒后无响应）。所以：① 关掉 followSymlinks；② 用函数式 ignored 精确排除
    //   android / _ocrlab_out / dist / node_modules / .git（glob 字符串在 chokidar 4 下已不再生效）。
    // 若设了环境变量 VITE_NO_WATCH=1，则完全禁用文件监视（HMR 关闭，改代码需手动刷新页面）。
    // 用途：app/android 是指向 C:\vocab-build\android 的 junction，本机（OneDrive 路径 + Node 24）
    // 下 chokidar 跟随它 stat 会抛 UNKNOWN(-4094) 并让 dev server 直接崩，而 server.watch.ignored
    // 拦不住这个 watcher；此时用 `VITE_NO_WATCH=1 npm run dev` 绕开。
    watch: process.env.VITE_NO_WATCH
      ? null
      : {
          followSymlinks: false,
          ignored: [
            join(import.meta.dirname, 'android'),
            join(import.meta.dirname, '_ocrlab_out'),
            join(import.meta.dirname, 'dist'),
            // 注意开头要允许没有分隔符的情况：chokidar 传进来的可能是相对路径（如 `android/...`），
            // 只写 [\\/] 会导致根目录下的这一级匹配不上，ignore 形同虚设。
            (p: string) => /(^|[\\/])(android|_ocrlab_out|dist|node_modules|\.git)([\\/]|$)/.test(p),
          ],
        },
    proxy: {
      // 本地开发：前端请求 /wb/* 由 Vite dev server 代理到 World Bank API，
      // 避免浏览器直连 api.worldbank.org 的网络/CORS 问题（部署后由 Worker 同路径代理）
      '/wb': {
        target: 'https://api.worldbank.org',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/wb/, ''),
      },
    },
  },
})
