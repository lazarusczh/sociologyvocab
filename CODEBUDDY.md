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
- 版本号改完补一个提交：`chore: bump android versionCode N / versionName X.Y.Z`。
- push 必须带代理：`git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 -c http.sslBackend=openssl push`。不要改 git config。
- 收尾校验：`app/dist/version.json` 与 `curl.exe -s https://9699vocab.cn/version.json` 必须一致。

## 二、云端数据库（psql 直连）

```powershell
$env:PGPASSFILE="$env:USERPROFILE\.pgpass"
psql "postgresql://postgres@spb-olltk79n0rjrawe5.supabase.opentrust.net:5432/postgres" -w -v ON_ERROR_STOP=1 -f db-migration-xxx.sql
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
- 信息流里的删除/清空类操作，不要用 `✓` / `✗` 之类的符号当强调符；正常写句子。

---

> 本文件与 `.codebuddy/rules/` 下的规则**只在会话开始时注入**：改动后需要**新开一个会话**才生效。
> 若某类错误被踩到第二次，处理方式不是"再往 project-memory.md 补一条"，而是把它升级进本文件或做成脚本。
