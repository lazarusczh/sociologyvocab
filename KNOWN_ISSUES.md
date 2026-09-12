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

## 3. 静态别名表的「死键」与 Beck 释义半截脱敏（2026-09-12，**已确认可接受，不必修**）

- **事实**：`app/src/lib/answer-aliases.json` 的 `scholarAliases` 是**按词条名精确匹配**的。其中 `"Ulrich Beck (& Elisabeth Beck-Gernsheim)"` 这条键在云端已不存在——教师早先把词条改名为 `Ulrich Beck`、把括号内合著者信息移入了**释义开头**（当时为统一各单元里的 Beck 词条、并做概念图谱人工标注），静态表的键没跟着改，故**永不匹配（死键）**。
  - 逐条比对结果：静态表 7 条里**只有这一条对不上**，其余 6 条（`America Sociology Association (ASA)` / `America Psychology Association (APA)` / `Centre for the Modern Family (quoted by Daily Mail)` / `Glasgow University Media Group (GUMG)` / `Michael (Dunlop) Young` / `RIAS (Ageas), a British insurance company`）均与云端词条名一致、正常命中。
- **影响：无功能影响**。Beck 的判定由「自动规则（完整原文 + 末尾姓氏 `Beck`）」与「云端 `item.aliases = ["Ulrich Beck","Beck"]`」双重覆盖，全名与 `Beck` 都判对。
- **该死键特意保留**（不删）：留着是零成本保险——若将来按旧格式再次导入带括号的 Beck 词条，它会立刻兜住 `Beck` 这个姓氏判定；而正常的 `Ulrich Beck` 词条永远匹配不到它，也就永远不生效。
- **已接受的现状**：Beck 释义以 `(& Elisabeth Beck-Gernsheim) …` 开头，而脱敏会把答案姓氏 `Beck` 也一并遮掉，学生看到的是 `(& Elisabeth ____-Gernsheim) …`。教师 2026-09-12 确认**可接受、无需改动**（Beck-Gernsheim 本身是复姓，且合著者不会作为考点；Beck 作为风险社会/个体化的门面，知道他就够）。
- **通用风险提示（值得记）**：静态别名表与 `surnameOverrides` 都按词条名精确匹配，**在云端改学者词条名会让对应条目静默失效**。若失效的是「非常规姓氏」类条目，判定会悄悄退回错误默认（如造 `hooks` 也算对）且没有任何报错。
  - **但风险面极小（2026-09-12 核实）**：当前全项目在用的 `surnameOverrides` **只有 1 条**——内置 `(Gloria Jean Watkins) bell hooks`（云端 `vocab_releases.surname_overrides` 为 `{}`、教师本机 0 条）；云端 238 位学者中「格式非常规」（含括号 / 全小写）仅 7 条，其余 6 条已由静态 `scholarAliases` 覆盖。**故唯一需要小心的键就是 `(Gloria Jean Watkins) bell hooks`**，不为此专门做体检工具，改学者词条名前扫一眼即可。
  - 历史：`surnameOverrides` 自 2026-08-21 引入以来总共只被实际使用过 2 次（上述 bell hooks + `Michael (Dunlop) Young`），且都在 08-23 收敛进静态表。该机制**不退役**——它是唯一能表达「**不认**某个自动推导」的通道（`item.aliases` 只能"多认"），且成本近乎为零。
- **另一个改名代价（更隐蔽，2026-09-12 查清）**：条目 id 由 `stableId(type, term, paper, category, units)` 计算（`app/src/lib/shuffle.ts:44`，**term 参与哈希**）→ **改词条名会换 id**；而学生的掌握度/错题本都按 id 关联，于是该词条的进度会断链（学生侧表现为「这条没学过」）。
  - **注意：「前端新建一个词条 + 删掉旧词条」与「改名」完全等价**（静态键失效、id 更换这两层代价一模一样），**不是**绕过办法；反而多一步、且旧条目删早了学生会直接看不到该词条。
- **真正免疫的做法**：把要认的写法写进该词条自己的「额外可接受答案」（`item.aliases`）——随发布上云、与「词条名字符串」无关，改名不受影响。但 `surnameOverrides` 那一类（管「**不认**某个默认推导」+ 脱敏用的姓氏，如 bell hooks 不能认 `hooks`）**不能**用 aliases 替代，必须留在静态/覆盖表，故这类词条改名要格外小心。
