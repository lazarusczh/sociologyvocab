import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 构建时生成 version.json：前端轮询该文件检测新版本（用于提示用户刷新到最新版）
function versionJson(): Plugin {
  return {
    name: 'gen-version-json',
    apply: 'build',
    closeBundle() {
      const version = String(Date.now());
      const outDir = join(import.meta.dirname, 'dist');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'version.json'), JSON.stringify({ version }), 'utf8');
      console.log(`[version] ${version}`);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), versionJson()],
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
