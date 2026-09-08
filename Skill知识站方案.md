# Skill 知识站方案：把蒸馏 Skill「置入」现有词汇网站

> 目标读者：教师（你自己）
> 定位：复用现有 `sociologyvocab`（9699vocab.cn）站点，把「已用 book-to-skill 蒸馏出的教材 Skill 包」开放给用户（学生）访问。
> 形态：A 可浏览的知识页 + B AI 问答（两者都做，分阶段落地）。
> 最后更新：2026-09-08

---

## 〇、一句话结论（TL;DR）

- **不要融进主 App 的 SPA**，而是做成**同域独立子路径** `/skill/*`：独立轻量前端 + 独立构建产物共存于同一 `dist/`，Cloudflare Assets 自动按路径服务，**主站 src/ 几乎零侵入**（只加了一个登录可见的导航外链）。
- **阅读站已落地（2026-09-08）**：`app/skill-site/` 独立 React 站 + 内容从云端 `skill_content` 拉取，9 章 + 211 术语 + patterns + cheatsheet 已可浏览。
- **版权保护三层已落地**：① 入口仅登录用户显示；② 静态产物不含教材内容；③ 云端 RLS（匿名读返回空）。已实测通过。
- **P1（下一步候选）**：加同源 `/skill-api/*` + AI 问答。AI 接入优先 **Cloudflare Workers AI（免费、无 API key）**；质量不达标再切 **DeepSeek/通义第三方 API**（key 放 worker secret，绝不放前端）。
- **版权红线**：Haralambos 教材是第三方版权作品。book-to-skill 官方明确「**不要把第三方版权书蒸馏出的 skill 公开分发**」。当前已做到**仅登录学生可见**（教育用途 + 访问控制），未对匿名互联网开放。

---

## 一、为什么用「同域子路径独立站」而不是直接改 App.tsx

现有 App.tsx 的页面是靠 `view` state 硬编码切换的（无 react-router），导航结构紧凑。把教材知识站塞进去意味着：加 View 枚举、改导航数组、改 AppBody 渲染分支、还要处理 IdentityGate 登录门槛，**任何一个改动都影响课堂教学主链路**。

而 skill 站本质是一套**只读 + 问答**的内容站，不需要词汇 App 的练习/打卡/RLS 等能力。两个构建产物、互不感知，是最干净的做法：

```
9699vocab.cn/
├── /                     → 现有词汇 App（dist/，完全不动）
├── /skill/               → 新知识站（dist/skill/，独立构建）
└── /skill-api/*          → Worker 上的 API（问答 / 检索），同源无 CORS
```

- Vite 支持多页面/独立入口：给 skill 站配一个小而独立的构建（`vite build --base=/skill/ --outDir=../dist/skill`，可单独 `package.json` 或同仓库 sub-folder），产物直接落进 `app/dist/skill/`。
- Cloudflare Assets 会按路径自动服务 `/skill/*`，**静态部分 worker 都不用改**，只有 API 需要 worker 路由。
- 可选入口：在词汇 App 首页加一个外链 `<a href="/skill/">`（不改导航、不加 view，仅一行链接），或者直接给学生发 `9699vocab.cn/skill/` 链接即可。

## 一·B、子路径骨架已落地（2026-09-08，构建验证通过）

「子路径」不是靠 Worker 路由"创建"的，而是**两个独立构建产物共存于同一个 `dist/`**，Cloudflare Assets 按 URL 自动匹配目录：

```
URL:   https://9699vocab.cn/skill/    →    磁盘: dist/skill/index.html
```

已建好的骨架（在 app/ 下，主站 src/ 与 worker.ts 零改动）：

```
app/
├── src/                    ← 主站（不动）
├── skill-site/             ← 子站独立源码（自己的 React 根，不复用主站代码）
│   ├── index.html
│   ├── vite.config.ts      ← root=本目录；base='/skill/'；outDir=../dist/skill
│   ├── tsconfig.json       ← include 只含 src（主 tsc -b 不会碰它）
│   └── src/                ← App.tsx + data.ts + index.css
├── vite.config.ts          ← 主站（不动）
└── dist/skill/             ← 子站产物（已成功构建，资源路径带 /skill/ 前缀）
```

### 关键代码

`skill-site/vite.config.ts`（两个要点：`base` 与 `outDir`）:

```ts
export default defineConfig({
  root: here,                       // 以 skill-site 为根
  base: '/skill/',                  // ★ 产物内所有资源路径带 /skill/ 前缀
  plugins: [react()],
  build: { outDir: join(here, '../dist/skill'), emptyOutDir: true },
})
```

`package.json` scripts：

```json
"dev:skill": "vite --config skill-site/vite.config.ts",
"build": "tsc -b && vite build && vite build --config skill-site/vite.config.ts"
```

### 三个已确认的关键结论

1. **主站 `tsc -b` 不会编译子站**：主 `tsconfig.app.json` `include: ["src"]`、`tsconfig.node.json` `include: ["vite.config.ts"]`，skill-site 完全在范围外，无需担心拖慢/破坏主站构建。
2. **hash 导航避开 SPA fallback 问题**：子站路由用 `#/chapter/<id>`、`#/glossary`，不用 history 路由 → 服务器永远只收到 `/skill/`，深链刷新/分享不会 404，Worker **无需加 fallback**。
3. **本地验证方式**：`npm run build:skill` 后产物落在 `dist/skill/`，用静态服务器托管 `dist` 访问 `localhost:<port>/skill/` 即可看到效果。

### 本地联调
- 子站独立跑：`npm run dev:skill` → 访问 `http://localhost:5174/skill/`（vite.config 已设 port 5174）。
- 或托管构建产物：`npx serve -l 4173 dist` → `http://localhost:4173/skill/`（已用此法验证可打开）。

## 一·C、版权保护 + 登录门禁已落地（2026-09-08）

**目标**：skill 内容来自 Haralambos 教材（版权作品），用户要求「仅注册登录用户可见」。

**三层防护，缺一不可**：

```
┌─ 第 1 层：入口只对登录用户显示
│  主站 App.tsx「资料」组加了 authOnly 的「教材知识库」href=/skill/
│  （未登录/离线游客看不到该入口）
├─ 第 2 层：静态产物不含任何教材内容（版权安全检查通过）
│  dist/skill/*.js 不含 "Durkheim/Bowles/socialisation" 等字样；
│  内容全部运行时从云端拉取
└─ 第 3 层（数据层硬隔离）：skill_content 表 RLS
   select 策略 = auth.uid() is not null（登录才可读）
   已验证：匿名 REST 请求返回 []（拿不到数据）
```

### 云端存储
- 新表 `public.skill_content`（见 `db-migration-skill-content.sql`）：`version` + `data(jsonb)` 整份蒸馏内容 + `note`。
- RLS：**任意登录用户可读**（含学生/教师）；**仅 teacher 角色可 insert**（发布新版本）；匿名一律读不到。
- 内容已导入 version 1（2026-09-08，9 章 + 211 术语 + 8 patterns + 10 cheatsheet）。

### 前端改造（app/skill-site/）
- `src/supabase.ts`：与主站同一 Supabase URL/anon key 建 client → **同域共享主站登录 session**（localStorage key `sb-<ref>-auth-token`），无需二次登录。
- `src/App.tsx` 三态：loading → guest（显示「前往登录」，跳主站 `/`）→ ready（拉 `skill_content` 渲染）。
- vite.config 加 `envDir: join(here, '..')` 读取 app/.env 的 Supabase 配置。
- 界面 4 板块：章节 / 术语表（含搜索）/ 答题模式 / 速查表，hash 导航。

### 主站入口（app/src/App.tsx）
- `NavItem` 扩展 `href?: string; authOnly?: boolean`；新增 `openNav()`：href 项整页跳转、否则 goto view。
- 资料组新增 `{ key: 'skill', label: '教材知识库', href: '/skill/', authOnly: true }`。
- 渲染处过滤 `authOnly && !authUser` 的项 → **未登录不可见**。

### 内容更新流程（教师）
```powershell
# 1. skill 产物更新后重新转换 → 生成导入 SQL → psql 执行（自动 version+1）
node scripts/skill-md-json.mjs "<skill目录>" "<temp>\skill-content.json"
node scripts/skill-import-sql.mjs "<temp>\skill-content.json" "<temp>\skill-import.sql"
psql "<conn>" -w -v ON_ERROR_STOP=1 -f "<temp>\skill-import.sql"
```
转换脚本 `app/scripts/skill-md-json.mjs`（markdown→JSON）+ `skill-import-sql.mjs`（JSON→幂等 INSERT）。

## 二、内容管道：Skill 包 → 站点数据

book-to-skill 蒸馏产物通常是：

```
<skill-slug>/
├── SKILL.md            # 总览 + 章节索引（~4k tokens）
├── chapters/ch01.md…   # 每章一个文件（按需加载）
├── glossary.md         # 术语表（字母序 + 章节引用）
├── patterns.md         # 模式 / 方法
└── cheatsheet.md       # 决策表 / 速查
```

这些 markdown 本身无法被网页直接消费，需要一步**转换脚本**（node，可放仓库根 `scripts/` 或 `app/scripts/`，风格参照已有的 `export-bank-import.mjs`）：

- 解析 `SKILL.md` 拿章节索引；
- 把 `chapters/*.md` 按 heading 切成 **chunk**（每个 chunk = 标题 + 正文纯文本 + 所属章 + 元数据）；
- 把 `glossary.md` 解析成 `[{term, definition, chapter}]` 结构化条目；
- 输出 `skill-data.json`（chunk 数组 + 术语数组 + 元数据），放 `dist/skill/` 供前端 fetch（参照现有 `public/social-data.json` 的消费模式）。

前端用轻量 React（或直接 vanilla）渲染三种视图：**章节目录 → 章节阅读（纯文本转 `<h1>/<p>` 即可，无需重度 markdown 引擎）→ 术语表（支持中英混合搜索，类似现有 Dictionary）**。P0 到这里就能给学生用了。

## 二·B、AI 问答已上线（2026-09-08，实测通过）

**架构（检索在前端、生成在 Worker）**：skill 内容登录后已整份在浏览器内存，因此 RAG 检索段**不需要服务端向量库**——前端本地对结构化内容做关键词/术语召回，把「问题 + 命中段落」发给 Worker，Worker 校验登录后调 Workers AI 流式生成：

```
学生提问 → 前端本地检索 top 段落（retrieval.ts）
            ├ 术语表精确命中（meritocracy → glossary）
            └ 章节段落关键词打分（ch05-education 等）
          → POST /skill-api/ask { question, system, context }
                  ↓
   Worker：校验 Supabase JWT（auth/v1/user）→ env.AI.run 流式 → SSE
                  ↓
   前端：SSE 解析 data:{"response":"..."}，打字机渲染 + 出处 chip
```

### 关键文件
- `app/worker.ts`：`/skill-api/ask` POST 路由。鉴权用 Supabase `auth/v1/user` 端点（worker 无需存任何私密凭据，仅 anon key）；模型 `@cf/meta/llama-3.1-8b-instruct-fp8`（免费额度内，实测一次问答 ≈ **2.7 neurons** / 158 prompt tokens，10k 免费日额度 ≈ 数千次问答）。
- `app/wrangler.toml`：加 `[ai] binding="AI"` + `[vars] SUPABASE_URL / SUPABASE_ANON_KEY`。
- `app/skill-site/src/retrieval.ts`：前端检索（中英分词：英文整词 + 中文双字组，术语优先命中加权）+ system prompt（教师角色 + 理论归类指纹 + AO1/2/3 口径）+ 出处收集。
- `app/skill-site/src/ask.ts`：fetch SSE 流式解析（含跨 chunk 缓冲与流尾兜底）。
- `app/skill-site/src/AskView.tsx`：问答 UI（气泡 + 建议问题 chips + 打字机 + 极简 markdown 渲染 + 出处）+ `app/skill-site/src/App.tsx` 挂 `#/ask`。
- `app/skill-site/src/index.css`：问答区样式（`.ask`、`.chip` 等）。

### 线上验证记录（2026-09-08）
- 匿名/无 token → 401（正确拦截）；
- 测试账号（临时注册后已删）带 token → SSE 正常流式输出，含 `data: [DONE]` 结束标记；
- 本地 `wrangler dev` 的 AI binding 报 `internal error` 是 **miniflare 本地模拟器已知限制**（search 证实），部署后 production 完全正常；
- 线上访问经 curl 需带浏览器 UA（Cloudflare WAF code 1010 拦裸脚本），浏览器内访问无此问题。

### 成本边界（决策依据，2026-09 查证）
- Workers Free 免费 **10,000 neurons/天**，超出即停（不自动扣费）；llama-3.1-8b-fp8 每 1k token 约 4~35 neurons → 一次问答约 3~15 neurons，日常教学量级碰不到上限。
- 第三方（DeepSeek 等）无平台级金额上限，需自己充值小额 + 应用侧计数拦截；故先 Workers AI 即可。

## 三、AI 问答：选型备查（已定 Workers AI）

> 原对比（A Workers AI / B 第三方）保留作切换备查：代码只动 worker 一个 provider 函数 + wrangler 配置即可切 B。

### 决策建议

| 维度 | A. Workers AI（已选） | B. 第三方 API |
|---|---|---|
| 成本 | 免费 10k neurons/天，实测一次问答 ≈3 neurons | 按量，小规模几元/月 |
| 配置 | `[ai] binding`（已配） | 需注册 + key + `wrangler secret put` |
| 上限 | 平台硬免费额度，天然不超支 | 无平台额度上限，需自计费控制 |
| 切换成本 | — | 低（仅换 provider 函数） |

## 四、分阶段落地计划

1. **M1 — 静态阅读站（零 AI）** ✅ 已完成并上线（2026-09-08）
   - 骨架 + 转换脚本（`app/scripts/skill-md-json.mjs`）+ 导入脚本（`skill-import-sql.mjs`）均就绪；
   - 内容已导入云端 `skill_content` v1，RLS 已启用（匿名读返回空，已实测）；
   - 子站 4 板块（章节/术语/模式/速查）+ 登录门禁 + Capacitor 返回兼容已部署，`9699vocab.cn/skill/` 线上 200 可访问。
2. **M2 — 登录门槛** ✅ 已完成（并入 M1）
   - 实现为「云端 RLS + 同域 session 共享」，比原「worker 校验 JWT」更简单且数据层硬隔离；子站 guest 显示「前往登录」门禁页。
3. **M3 — AI 问答（Workers AI）** ✅ 已完成（2026-09-08，线上实测通过）
   - `[ai] binding` + `/skill-api/ask` + 前端问答 UI 全部就绪并部署；
   - 鉴权拦截（401）、流式 SSE、出处标注均已线上验证；
   - 待真实学生端体验反馈后判断是否切 B（DeepSeek）。
4. **M4 — 质量不足则切第三方 API；最后走「三步走」发布收尾。**

## 五、已确认 / 待确认

**已确认**
- ✅ skill 产物路径：`C:\Users\rebir\.agents\skills\9699textbook1\`（9 章 + 211 术语 + patterns + cheatsheet，≈92KB md）；
- ✅ 登录可见：仅注册登录用户（主站账号体系），匿名在数据层读不到内容。

**待确认（下一步）**
- [ ] 是否上线部署（走「三步走」），然后学生端实测；
- [ ] 若做 AI 问答（M3）：问答结果是否允许 AI 自由发挥 vs 仅检索段落（可配置，课堂演示求稳时应「只答检索到的内容 + 出处」）。
