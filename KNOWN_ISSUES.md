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

## 4. 平板网页端 / APK 登录报 `Failed to fetch`——根因：证书根为较新的 GlobalSign Root R46，老安卓信任库不含（2026-09-12 首次报，09-13 定位）

- **现象**：① 安卓平板浏览器登录网页端（`https://9699vocab.cn`）弹 `Failed to fetch`，几分钟后"自行恢复"；② 09-13 复现：访问 `.../auth/v1/health` 时平板**提示证书有问题**，点「继续」后浏览器端登录立即恢复正常；③ 把最新 APK 装到同一台平板后，**App 内持续报 `Failed to fetch`**（WebView 没有"继续访问"这个选项，无法绕过）。
- **报错来源**：`app/src/lib/store.tsx` 的 `signIn()` 把 `supabase.auth.signInWithPassword()` 返回的 `error.message` **原样显示**。该文案是浏览器对「**请求没拿到响应**」的统一表述（DNS 解析失败 / 连接超时 / TLS 校验失败 / **CORS 预检失败** / 被浏览器策略拦截），**不是密码错**——密码错会显示 `Invalid login credentials`。
- **已排除**：① CORS——对 `.cn` 与 `workers.dev` 两个 Origin 的 `OPTIONS` 预检均返回 `Access-Control-Allow-Origin: *`（`auth/v1/token` 与 `auth/v1/health` 都测过）；② 域名与静态资源——`9699vocab.cn` 正常返回应用，且平板上「跳过登录·离线使用」可用（说明页面与脚本正常，只有到 Supabase 的跨站请求失败）；③ anon key 有效期（`exp` ≈ 2036）；④ 平板系统时间（教师确认正常）；⑤ 该主机无 AAAA（IPv6）记录，不存在"IPv6 黑洞导致偶发超时"的情况。
- **根因（2026-09-13 定位，证据充分）**：`spb-olltk79n0rjrawe5.supabase.opentrust.net` 的证书链为 `CN=opentrust.net`（Alibaba China）← `GlobalSign GCC R46 OV TLS CA 2025` ← **`GlobalSign Root R46`**。服务器**已正确下发中间证书**（openssl `-showcerts` 实测 2 张链、`Verify return code: 0`），叶子证书有效期 2026-06-30 → 2027-01-15、TLS 1.3、sha256RSA，**证书本身完全正常**。问题在**信任库差异**：Windows 有 `GlobalSign Root R46`（PC 一切正常），而**较老的 Android 系统信任库没有这个较新的根** → 浏览器报证书错误（可手动"继续"），**WebView 无法继续** → APK 恒定失败。此前那次"自愈"其实是浏览器**记住了点过的证书例外**，并非网络抖动。
- **未取的证据（下次发生时按此顺序抓，30 秒可定位）**：
  1. 地址栏直接开 `https://spb-olltk79n0rjrawe5.supabase.opentrust.net/auth/v1/health` —— **首先看是否弹证书警告**：弹了 = 该设备信任库不认这个证书（即本条根因，只需看证书页里的报错码，通常是 `ERR_CERT_AUTHORITY_INVALID`）；不弹且看到 `{"message":"No API key found in request"}` = 网络与证书都正常；转圈/超时 = 网络或 DNS 问题；
  2. **换另一个浏览器 / 无痕窗口**登录同一网址 —— 能登 = 原浏览器的拦截（省流、隐私保护、去广告、VPN 类 App）；不能 = 网络侧；
  3. **换手机热点**再试 —— 能登 = 原 WiFi/局域网的 DNS 或网关问题；
  4. 记录当时网络环境（校园网/热点/VPN/省流模式）与设备上装的加速、去广告类 App。
- **对策（按推荐顺序）**：
  - **A（✅ 2026-09-13 已实施，采用"直连优先 + 失败回退"变体 A′）**：把 Supabase 的 auth / REST 调用改为经 Cloudflare Worker **同源代理** `/sb/*` → 中招设备只依赖 `9699vocab.cn` 的 Cloudflare 证书（**任何安卓版本都受信**），网页端不再弹证书警告、APK 也能登录。选 A′ 而非"全量代理"的原因：全量会让**所有**学生请求绕道 Cloudflare 境外边缘再回国内阿里云（估每条 +100~300ms、首次拉整份词库更明显），而 A′ 只在直连失败时才切代理，正常设备零影响。
  - **B（不由我们控制）**：请阿里云把该域名的证书链换成**根更老、Android 全版本受信**的 CA（例如 GlobalSign Root CA - R3 系）。
  - **C（仅应急，且只在你自用的 APK 内）**：在 `MainActivity` 的 `WebViewClient.onReceivedSslError` 里对 `*.opentrust.net` 放行 —— ⚠️ **该域名在 App 内将失去证书校验（中间人风险）**，故**不应**用于会交给学生使用的构建。
- **关联**：学生反馈池若出现同样症状（"登录失败/打不开"），优先按上面 4 步抓证据，而不是直接查库。
