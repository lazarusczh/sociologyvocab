# 社会学词汇（sociologyvocab）

教师自用的社会学词汇教学站。Web（Cloudflare Workers + Vite/React）+ Android APK（Capacitor）；数据在阿里云 Supabase 兼容服务。

- 仓库根 = 本目录；**前端源码在 `app/`**（git 仓库也在项目根，不在 app 内）
- 生产：`https://9699vocab.cn`（Worker 名 `sociologyvocab`）
- 详细记忆库：`project-memory.md`（工程约定 + 踩坑史）、`交接索引.md`（导航）
- 本文件只放**每次会话都必须遵守**的硬约束。触发到具体事务时，先读对应章节再动手，不要凭印象。

## 一、发布 / 打包 / 部署（"三步走"）

顺序固定，不可调换：

1. `git commit` + `push` —— **提交信息只能用 ASCII/英文**（中文经 PowerShell 传参会 GBK/UTF-8 双重乱码）
2. 改 `app/android/app/build.gradle`：`versionCode` +1、`versionName` 递增（**已漏过两次，务必在打包前改**）。
   注意：`app/android` **已不被本仓库跟踪**（它是指向 `C:\vocab-build\android` 的 junction，且另有自己的 git 仓库，2026-09-22），所以这个改动**不会出现在本仓库的 `git status` 里、也不需要提交** —— 只改文件本身（打包读它）
3. `$env:CODEBUDDY_SAFE_DELETE_ENABLED='0'` 然后 `npm run ship`（在 `app/` 下）

铁律：

- **全程只允许一次构建。** `npm run ship` = `npm run release` + `npx wrangler deploy`；其中 `release` = `build` → `node scripts/android-release.mjs` → 自动发飞书 APK。
  **`android-release.mjs` 只做 `cap copy`（不跑 `cap sync`）**：它把 `dist` 复制到真实路径 `C:\vocab-build\android\app\src\main\assets\public`、把 gradle 里 `../node_modules` 的相对引用改写成绝对路径，再在真实路径跑 `gradlew.bat assembleRelease`。原因：**CodeBuddy 的进程在受限完整性级别下穿不过任何 mount point**（`WinError 448`），`cap sync android` 与 `cd android` 都会失败（老流程保留为 `npm run release:cap`，在普通终端里可用）。
  ⇒ **新增或升级 Capacitor 插件之后**，必须先在**普通终端**里跑一次 `cd app && npx cap sync android` 同步原生依赖，再用本脚本打包；平时不用。**部署必须在 release 之后，且之后不得再 build**；若"先部署再 release"或"跑两次 build"，`vite.config.ts` 的 `BUILD_VERSION = Date.now()` 会产出两个版本号，导致 APK 内嵌 `version.json` 与线上不一致（2026-09-12 踩过）。所以**不要分步跑 `npm run build`**。
- `CODEBUDDY_SAFE_DELETE_ENABLED='0'` 必设：IDE 安全删除层把删除改成"移入回收站"，OneDrive 路径下该操作会失败，构建清空 `app/dist/skill` 时直接挂（`[plugin vite:prepare-out-dir]`）。设上之后一条 ship 通常就跑通，**不需要预先 clean**。
- **`app/android` 已整体移出 OneDrive（junction），不要当普通目录处理**（2026-09-17）：
  - `app/android` 现在是个 **junction**，指向 `C:\vocab-build\android`。内容不在 OneDrive 内，OneDrive 看不见、不同步它。
  - **本仓库已不跟踪 `app/android`**（2026-09-22；它另有自己的 git 仓库）。所以对它内部的改动（例如版本号）不会出现在本仓库的 `git status` 里 —— 读到「改了 build.gradle 但 status 里没有」不要以为是没保存。
  - **不要删除、移动、或以普通目录的方式复制 `app/android` 本身** —— 会破坏联接。要换位置就删掉 junction 再重建。
  - 若它突然变成"无法访问的文件夹"：说明 `C:\vocab-build\android` 丢了，从 `C:\vocab-build\android.od-bak`（迁移前的完整副本，791 文件 / 44.8 MB）恢复即可；确认无需回退后可删该副本。
  - `app/android/app/build.gradle` 与 `app/android/build.gradle` 里的 `layout.buildDirectory.set(...)` **保留**，作为第二层保险。
  - **起因**：OneDrive 会把 `android` 下的条目接管成"云占位"（属性 `525328`/`525360`/`525344`，含 `PINNED | REPARSE_POINT`）。先是 `:app:packageRelease` 删不掉中间目录，后来 `:app:mergeReleaseAssets` 报 `Cannot snapshot ...: not a regular file`（文件内容不在本地，Gradle 的 `Files.isRegularFile()` 返回 false）。**后者无法靠 Gradle 配置绕过**（assets 必须真读出来打进 APK），只能让文件脱离 OneDrive。当天还遇到 OneDrive 自身卡死（`metadata.sqlite-shm` 被锁、卡在 61%、暂停同步也点不动），使 `android/app/src` 全体进入中间态，最后靠重启电脑恢复；**不要强杀 OneDrive 进程**（教师反馈曾导致重启后它认不出同步根配置）。
  - **根治方向仍是把仓库移出 OneDrive**；junction 只是先把打包这条链摘出来。
- **junction 实测有效（2026-09-18，1.7.23 打包）**：`:app:packageRelease` 所在的整条 `assembleRelease` **34 秒跑完**（`171 actionable tasks: 10 executed, 161 up-to-date`），`Unable to delete` 一次未现。对照此前：每次必挂在 `incremental/packageRelease/tmp`，且重试无效、耗时近 2 分钟。增量构建还能保留（`161 up-to-date`），所以不必每次全量重编。**若哪天又出现删除失败，先确认 `app/android` 还是不是 Junction 指向 `C:\vocab-build\android`。**
- **`feishu:send-apk` 只能用工作区内的相对路径**：`lark-cli` 的 `--file` 拒收绝对路径（报 `invalid_argument: --file must be a relative path within the current directory`），所以脚本先 `copyFileSync` 到 `_ocrlab_out/app-release.apk` 再发。改了构建目录就必须同步改这个拷贝源，否则报文件不存在。
- **ship 中途挂掉后的补救**：若前端 `npm run build` 已成功、只是后半段（打包 / 发 APK / 部署）失败，**不要重跑整条 `npm run ship`**（二次 build 会让版本号分叉），改为单独补跑缺的步骤：`node scripts/android-release.mjs`、`npm run feishu:send-apk`、`npx wrangler deploy`，最后仍要校验 `app/dist/version.json` 与线上一致。
- 版本号**不需要提交**（`app/android` 不在本仓库里，见第 2 步）。旧约定「补一个 `chore: bump ...` 提交」已作废。
- APK 落在 `C:/vocab-build/app/outputs/apk/release/app-release.apk`（构建目录已移出 OneDrive，见下方铁律）。
- push 必须带代理：`git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 -c http.sslBackend=openssl push`。不要改 git config。
- 收尾校验：`app/dist/version.json` 与 `curl.exe -s https://9699vocab.cn/version.json` 必须一致。

## 二、云端数据库（psql 直连）

**连接串不在本文件明文写出**（本仓库公开）。主机、端口、库名、用户名都在 `%USERPROFILE%\.pgpass` 的**唯一一条**里，格式 `host:port:database:user:password`；密码由 `PGPASSFILE` 自动读取，**不要写进命令**。

```powershell
# 现场拼连接串：取 .pgpass 唯一一条的前四段（不显示密码）
$env:PGPASSFILE = "$env:USERPROFILE\.pgpass"
$e = (Get-Content $env:PGPASSFILE | Where-Object { $_.Trim() -and -not $_.StartsWith('#') })[0] -split ':'
$conn = "postgresql://$($e[3])@$($e[0]):$($e[1])/$($e[2])"
psql $conn -w -v ON_ERROR_STOP=1 -f db-migration-xxx.sql
```

- **`PGPASSFILE` 与 `-w` 都不能省。** 漏了的话 psql 会停在密码提示上，终端表现是"命令无响应"（已踩三次；psql 本身就在 PATH 里，`C:\Program Files\PostgreSQL\17\bin\psql.exe`，不是路径问题）。只读自查也要带上 `-w`。
- 迁移文件放仓库根，命名 `db-migration-*.sql`，**写成幂等**（`if not exists` / `create or replace`），确保可重复执行。
- 引擎是 AnalyticDB/Greenplum 内核：**部分唯一索引、表达式索引的支持不确定**；唯一性优先由应用层保证（写方都是教师端小规模代码）。
- 改表前先确认影响面，事后用数据自查：`count(*)` 对比、新增列是否只加可空列、RLS 策略是否被动过。

## 三、词库双源（别改错地方）

- 词条内容（term / 释义 / paper / category / unit / 答案容错）**只在云端改**：教师账号在 VocabManager 在线改 → 发布到 `vocab_releases`。
- 本机数据源（`unit-mapping.json` / `answer-aliases.json` / `*.xlsx`）**只用于代码与结构改动**，改完也要重新发布到云端。
- 若某指令可能让本机数据源与云端分叉：**停下并提示去云端改**，不要直接改本机数据源。
- **答案判定口径在服务端有一份物化副本**（2026-09-22 建）：`vocab_answer_forms` 表 + `public.normalize_answer()` 函数，在教师端「发布词库」时自动重建（另有「重建判定表」按钮）。**两条纪律**：① 改了 `app/src/lib/answers.ts` 的判定规则（`normalizeKey` / 单复数 / 姓氏推导）或 `app/src/lib/answer-aliases.json`，必须在教师端点一次「重建判定表」；② 改完跑 `cd app; node scripts/answer-forms-check.mjs` 做 JS 与 SQL 的归一化对拍（当前 5508/5508 一致）—— 不一致会以「某个词学生写对了却判错」的形式**静默**出现。详见 `实时多人在线功能规划.md` 第九节附。

## 四、绝不能动的既有流程

- 现有「复制成绩（邮箱⇥分数）→ 油猴脚本在 ManageBac 页面粘贴」的手动兜底流程**必须原样保留**：`PaperResults.tsx` 与 `QuizManager.tsx` 的「复制成绩（ManageBac）」按钮、以及它输出的 `邮箱<Tab>分数` 格式，**不得移除、不得改格式**（该流程零凭证，是浏览器自动化不可用时的唯一退路）。新同步功能只能是**新增**。

## 五、隐私与仓库

- 公开 GitHub 仓库必须排除：`*.xlsx`、`app/public/vocab-data.json`、`reset-tool/`、`teacher-private-key.json`、`*.apk`、`A1/A2 Paper*.pdf`、`pdf-text/`、`ppt-text/`、`pdf-libs/`、`unit-tags-backup/`。
- 学生端 RLS 完全隔离（只能读写自己的 `student_data` / `quiz_submissions`）；姓名权威源是 `auth.users.user_metadata.name`。
- `app/_ocrlab_out/` 下有 ManageBac 登录 cookie 与含真实学生姓名的勘探产物（已被 `.gitignore` 覆盖）：**不要外发，用完即删**。

## 六、界面与交互约定（改了容易返工）

- 学生端看不到教师功能；开关由云端 `isTeacher` 控制，不用本机 `IS_ADMIN`。
- 教师后台：宽屏（≥1100px）左侧栏，窄屏两级药丸导航，两种宽度共用同一份位置记忆。
- 横向滚动表格统一用 `.check-table`：首列冻结，投影**只在真正横滑时**出现（`app/src/lib/tableFreeze.ts` 用捕获阶段监听，一处管全站）。
- **`CategoryFilter` 自带一层 `card`**：接入它的页面（拼写、选择题、课堂活动…）**不要再套一层 `<div className="card">`** —— 会变成卡片叠卡片。正确写法见 `Spelling.tsx`：`CategoryFilter` 与下面的说明/按钮区**并列**即可。
- **不要用对勾、叉号之类的符号当强调**：回答文字、思考过程、代码注释、文档全都不要用。需要表达判断时正常写"可行 / 不可行"、"是 / 否"、"已过期"。
  项目早期文档里残留了一些这类符号（如 `定义题方案.md`、`DevPanel.tsx` 等）：**不要模仿，也不必为了对齐它们而使用**。

## 六·五、类型检查的覆盖范围（2026-09-17 的教训，务必先读）

- **`tsc -b` 默认只检查 `app/src`，不检查 Worker。** `tsconfig.app.json` 的 `include` 是 `["src"]`，所以 `app/worker.ts` 与 `app/worker/**` **长期不在任何类型检查范围内** —— 改完 Worker 后跑 `tsc -b` 显示"通过"，**不代表 Worker 没问题**。
- 2026-09-17 因此漏掉两个只在**运行时**才炸的错误，导致子站问答**整站 500**：① `AI_TIER_CATALOG` 引用了之后才定义的 `OR_MODEL`（`const` 暂时性死区）；② 模块级的 `aiHeaders` 引用了 `handleAsk` **函数内部**的 `sseHeaders`（作用域错误）。两者都让模块加载即抛 `ReferenceError`，而类型检查一声不吭。
- **已修**：新增 `app/tsconfig.worker.json`（含 `worker.ts` 与 `worker/**/*.ts`，装 `@cloudflare/workers-types`，开 `strict` + `noUnusedLocals`），并**加入 `tsconfig.json` 的 `references`** —— 现在 `npm run build` / `npm run ship` 会连带检查 Worker。
- **纪律**：改完 Worker 代码，除 `tsc -b` 外还要**实际发一次请求**验证。最快的判据：`curl -s -o NUL -w "%{http_code}" -X POST https://9699vocab.cn/skill-api/ask` 返回 **401**（走到鉴权）而非 500（模块加载就炸）。
- 顺带：开 `noUnusedLocals` 后清掉了 `MS_V4`（从未接进任何调用分支的死代码）。

## 六·六、本地 dev server（2026-09-22）

- **必须用 `VITE_NO_WATCH=1 npm run dev` 启动**（PowerShell：`$env:VITE_NO_WATCH='1'; npm run dev`）。
  原因：`app/android` 是指向 `C:\vocab-build\android` 的 junction（见第一节），本机（OneDrive 路径 + Node 24）下
  chokidar 跟随它 stat 会抛 `UNKNOWN: stat '...\app\android'`，**让 dev server 刚打印 ready 就崩掉**。
  `server.watch.ignored` 试过字符串 glob、绝对路径、正则、函数四种形式**都拦不住**这个 watcher，
  只有 `server.watch: null` 有效 —— 已在 `app/vite.config.ts` 做成环境变量开关，不设变量时行为不变。
- 代价：**HMR 关闭，而且 vite 也不会自己发现文件变化** —— 改完代码光刷新页面拿到的仍是**旧的编译结果**（现象酷似「改动没生效 / 新入口不见了」，2026-09-22 为此白查了一轮）。**改完前端代码必须重启 dev server**：
  `$p=(Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1 -ExpandProperty OwningProcess); if($p){Stop-Process -Id $p -Force}; cd app; $env:VITE_NO_WATCH='1'; Start-Process npm.cmd -ArgumentList 'run','dev' -RedirectStandardOutput "$env:TEMP\vd-out.log" -RedirectStandardError "$env:TEMP\vd-err.log" -WindowStyle Hidden`
- 端口固定 5173。`server.watch.ignored`（字符串 glob / 绝对路径 / 正则 / 函数，连锚点都补过）**都拦不住**那个 watcher，不要再回头去试 `ignored`，直接用 `VITE_NO_WATCH`。
- 需要后台起并看日志时：
  `cd app; $env:VITE_NO_WATCH='1'; Start-Process npm.cmd -ArgumentList 'run','dev' -RedirectStandardOutput "$env:TEMP\vocab-dev.log" -RedirectStandardError "$env:TEMP\vocab-dev.err.log" -WindowStyle Hidden`
  然后 `Get-Content "$env:TEMP\vocab-dev.log" -Tail 20` 查看（注意别让命令文本里出现 watch 关键字，否则执行器会把它当成 watch 命令、吞掉输出）。

## 七、AI 通道（魔搭 ModelScope）

- **模型 id 会过期，绝不能照抄记忆或旧文档里的 id。** 2026-09-17 魔搭下架了整个 `Qwen/Qwen3-*` 系列（含子站问答的文本主力 `Qwen/Qwen3-235B-A22B` 与 OCR 的 `Qwen/Qwen3-VL-*`），调用一律返回 400 `Model id : ... , has no provider supported`。**改任何模型前先跑 `node scripts/ms-models.mjs`**（在 `app/` 下）：它从源码提取所有 `MS_*` 模型 id、列出账号可见模型、再逐个探测（每个 1 token）。加 `--list` 则完全不消耗额度。
- **魔搭免费池本身也不稳定**：同一批请求里会出现「HTTP 200 但 choices 为空」。所以多级降级链必须保留，不要因为某个模型当下可用就删掉后面的兜底。
- **失败详情要原样透出，不要截太短**：`/app-api/ai/transcribe` 等的 `detail` 是教师唯一的排查线索。曾截到 40 个字符，导致「模型已下架」被误读成「rate limit」（2026-09-17）。

## 八、ManageBac 相关（同步功能的基建）

- **刷新 ManageBac 登录 cookie：用 `app/scripts/mb-login-local.mjs`**（调本机已装 Chrome/Edge，独立 profile `%LOCALAPPDATA%\mb-login-profile`，刻意不放工作区以避开 OneDrive）。快、**不消耗 Cloudflare 浏览器额度**、profile 复用后通常免登录。
  **不要用 `cf-managebac-login.mjs`**：那是远端投屏（浏览器在 CF 机房，键鼠往返很卡）且**消耗额度**（2026-09-16 又踩一次）。
- 只读排查/抓取：`node scripts/mb-tasks.mjs --class <班级号> [--code <短码>]`。班级号：**AS = `11496547`**、**A2 = `11420931`**。
- Cloudflare Browser Run 免费额度 **10 分钟/天**（按天重置，不额外扣费）；一轮"建会话+开页+读结构+关闭"约 8~15 秒。**脚本必须显式关闭会话**，否则会一直占额度。
- 抓取只做只读：不读取、不输出任何学生姓名与分数（学生定位另有名单桥接方案）。cookie 与勘探产物都在 `app/_ocrlab_out/`（已 gitignore），不要外发。

---

> 本文件与 `.codebuddy/rules/` 下的规则**只在会话开始时注入**：改动后需要**新开一个会话**才生效。
> 若某类错误被踩到第二次，处理方式不是"再往 project-memory.md 补一条"，而是把它升级进本文件或做成脚本。
