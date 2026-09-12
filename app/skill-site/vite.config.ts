import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// 独立子站：产物输出到主站 dist/skill/，由 Cloudflare 按 /skill/ 子路径静态托管
export default defineConfig({
  root: here,
  base: '/skill/',
  plugins: [react()],
  // 与主站共享 app/.env 里的 Supabase URL / anon key（登录会话同域共享）
  envDir: join(here, '..'),
  build: {
    outDir: join(here, '../dist/skill'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    // 允许读取 root 之外的文件：子站复用主站 app/src/lib 下的共享模块（如 supabaseFetch.ts）
    fs: { allow: ['..'] },
  },
})
