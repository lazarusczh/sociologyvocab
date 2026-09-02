# 已知隐患 / Known Issues

## 1. 词库同步刷新会无条件覆盖未发布编辑（数据丢失风险）

- **触发点**：`app/src/lib/store.tsx` 的 `syncVocabFromCloud()`（约 248 行）
  - `Home.tsx:35`「回首页」`useEffect` 触发
  - `store.tsx:281` `authUser` 变化（登录 / 刷新登录态）触发
- **现状逻辑**（store.tsx:251-268）：只要云端 `vocab_releases` 最新版本号 `> loadVocabVersion()`，就直接 `persistVocab(migrated)` 整体覆盖本地词库，并 `saveVocabVersion(pulled.version)`。
  - **未检查 `vocabDirty` 标记**：本地有未发布编辑（`vocabDirty=true`，版本号仍为旧值）时，云端更高版本号会静默覆盖，编辑全部丢失；banner 仅提示「已更新到 vX」，不告警。
  - `VocabManager` / `ImportPanel` 虽在 UI 上用 `vocabDirty` 提示「有未发布修改」（见 `VocabManager.tsx:322`、`ImportPanel.tsx:150`），但**只展示、不阻止同步覆盖**。
  - `vocabDirty` 仅在「发布新版本」时 `clearVocabDirty()`（`ImportPanel.tsx:57`）清除；导入 / 编辑均 `setVocabDirty(true)`。
- **影响**：教师在 VocabManager 改了逻辑关系 / 流派但忘了点「发布」，随后刷新页面或重新登录，改动丢失。
- **建议修复（待做，改动小）**：`syncVocabFromCloud` 开头加 `if (vocabDirty)` 保护——跳过自动覆盖并提示用户「本地有未发布改动，是否用云端覆盖？」（确认 / 取消）；或仅在 `!vocabDirty` 时自动拉取。
- **当前规避方式**：编辑完务必点「发布新版本」（`vocabDirty` 置 false 后才安全）。

## 2. 引号规范化修正（个人习惯，不归档）

- 2026-09-02 将词库中残留的中文单引号 `‘’`（U+2018 / U+2019）统一改为直引号 `'`（共 6 处，随 v55→v56 发布）。
- 属个人输入习惯修正，**未走 git 归档**（无对应 db-migration SQL 入库）；云端 v56 为干净版。
- 排查方法：`app/src/lib/cloud.ts` 拉取 `vocab_releases` 最新版本，遍历 `data` 数组对每条 `term/definition/aliases/中文` 字段正则 `[\u2018\u2019]` 全量扫描即可。
