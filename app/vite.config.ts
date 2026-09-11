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
