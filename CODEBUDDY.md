# 社会学词汇（sociologyvocab）

教师自用的社会学词汇教学站。Web（Cloudflare Workers + Vite/React）+ Android APK（Capacitor）；数据在阿里云 Supabase 兼容服务。

- 仓库根 = 本目录；**前端源码在 `app/`**（git 仓库也在项目根，不在 app 内）
- 生产：`https://9699vocab.cn`（Worker 名 `sociologyvocab`）
- 详细记忆库：`project-memory.md`（工程约定 + 踩坑史）、`交接索引.md`（导航）
- 本文件只放**每次会话都必须遵守**的硬约束。触发到具体事务时，先读对应章节再动手，不要凭印象。

## 一、发布 / 打包 / 部署（"三步走"）

顺序固定，不可调换：

1. `git commit` + `push` —— **提交信息只能用 ASCII/英文**（中文经 PowerShell 传参会 GBK/UTF-8 双重乱码）
2. 改 `app/android/app/build.gradle`：`versionCode` +1、`versionName` 递增（**已漏过两次，务必在打包前改**）
3. `$env:CODEBUDDY_SAFE_DELETE_ENABLED='0'` 然后 `npm run ship`（在 `app/` 下）

铁律：

- **全程只允许一次构建。** `npm run ship` = `npm run release`（build → cap sync → gradlew assembleRelease → 自动发飞书 APK）+ `npx wrangler deploy`。**部署必须在 release 之后，且之后不得再 build**；若"先部署再 release"或"跑两次 build"，`vite.config.ts` 的 `BUILD_VERSION = Date.now()` 会产出两个版本号，导致 APK 内嵌 `version.json` 与线上不一致（2026-09-12 踩过）。所以**不要分步跑 `npm run build`**。
- `CODEBUDDY_SAFE_DELETE_ENABLED='0'` 必设：IDE 安全删除层把删除改成"移入回收站"，OneDrive 路径下该操作会失败，构建清空 `app/dist/skill` 时直接挂（`[plugin vite:prepare-out-dir]`）。设上之后一条 ship 通常就跑通，**不需要预先 clean**。
- **Gradle 的构建目录已在 OneDrive 之外，不要改回去**：`app/android/app/build.gradle` 与 `app/android/build.gradle` 里各有一句 `layout.buildDirectory.set(file('C:/vocab-build/...'))`。原因是 OneDrive 会把 `android/app/build` 下的目录接管成"云占位"（属性 `525361` = `PINNED | REPARSE_POINT`），Gradle 便删不掉自己的中间目录，表现为 `:app:packageRelease FAILED` + `java.io.IOException: Unable to delete directory .../incremental/packageRelease/tmp`，**重试无效、必挂在同一处**（2026-09-16 连挂两次，误判过一次是 daemon 占用）。中间产物挪到 OneDrive 之外后由 Gradle 自由管理，源码仍在 OneDrive。**再见到这个报错，第一件事查这两处配置是否还在。**
- **`feishu:send-apk` 只能用工作区内的相对路径**：`lark-cli` 的 `--file` 拒收绝对路径（报 `invalid_argument: --file must be a relative path within the current directory`），所以脚本先 `copyFileSync` 到 `_ocrlab_out/app-release.apk` 再发。改了构建目录就必须同步改这个拷贝源，否则报文件不存在。
- **ship 中途挂掉后的补救**：若前端 `npm run build` 已成功、只是后半段（打包 / 发 APK / 部署）失败，**不要重跑整条 `npm run ship`**（二次 build 会让版本号分叉），改为单独补跑缺的步骤：`cd android && gradlew.bat assembleRelease`、`npm run feishu:send-apk`、`npx wrangler deploy`，最后仍要校验 `app/dist/version.json` 与线上一致。
- 版本号改完补一个提交：`chore: bump android versionCode N / versionName X.Y.Z`。
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
- **不要用对勾、叉号之类的符号当强调**：回答文字、思考过程、代码注释、文档全都不要用。需要表达判断时正常写"可行 / 不可行"、"是 / 否"、"已过期"。
  项目早期文档里残留了一些这类符号（如 `定义题方案.md`、`DevPanel.tsx` 等）：**不要模仿，也不必为了对齐它们而使用**。

## 七、ManageBac 相关（同步功能的基建）

- **刷新 ManageBac 登录 cookie：用 `app/scripts/mb-login-local.mjs`**（调本机已装 Chrome/Edge，独立 profile `%LOCALAPPDATA%\mb-login-profile`，刻意不放工作区以避开 OneDrive）。快、**不消耗 Cloudflare 浏览器额度**、profile 复用后通常免登录。
  **不要用 `cf-managebac-login.mjs`**：那是远端投屏（浏览器在 CF 机房，键鼠往返很卡）且**消耗额度**（2026-09-16 又踩一次）。
- 只读排查/抓取：`node scripts/mb-tasks.mjs --class <班级号> [--code <短码>]`。班级号：**AS = `11496547`**、**A2 = `11420931`**。
- Cloudflare Browser Run 免费额度 **10 分钟/天**（按天重置，不额外扣费）；一轮"建会话+开页+读结构+关闭"约 8~15 秒。**脚本必须显式关闭会话**，否则会一直占额度。
- 抓取只做只读：不读取、不输出任何学生姓名与分数（学生定位另有名单桥接方案）。cookie 与勘探产物都在 `app/_ocrlab_out/`（已 gitignore），不要外发。

---

> 本文件与 `.codebuddy/rules/` 下的规则**只在会话开始时注入**：改动后需要**新开一个会话**才生效。
> 若某类错误被踩到第二次，处理方式不是"再往 project-memory.md 补一条"，而是把它升级进本文件或做成脚本。
