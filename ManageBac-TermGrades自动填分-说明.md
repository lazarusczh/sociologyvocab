# ManageBac Term Grades 等第批量填入 · 使用说明

> 文件：`managebac-term-grade-filler.user.js`
> 与「词汇项目」无关的独立小工具：把 ManageBac 自己导出的 `TermGrades.xlsx` 里的等第，自动填回 ManageBac 的 **Term Grades** 页面。
> 最后更新 2026-10-30

---

## 一、它做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 读你从 ManageBac 导出的 Term Grades xlsx | 不读、不传、不存任何学生数据到网上 |
| 按**姓名**把表里的学生和页面上的学生对应起来 | 不猜：同名多人直接跳过并提示 |
| 把勾选列的等第写进页面上的输入框 / 下拉框 | 不碰 `N/A` 和空值（默认跳过） |
| 每写一格都回读校验，失败单独报出来 | 不做百分比换算，字母等第原样填 |

匹配用姓名是因为：**导出的表本身就是 ManageBac 的产物**，两边的姓名写法天然一致，不存在「站内名 vs ManageBac 名」对不上的问题。

---

## 二、安装

1. 浏览器装好 Tampermonkey
2. 打开 Tampermonkey 面板 → 「添加新脚本」
3. 把 `managebac-term-grade-filler.user.js` 全文粘进去 → 保存
4. 打开任意 `*.managebac.cn` / `*.managebac.com` 页面，左下角应出现「Term Grades 等第填入」面板

> 面板只在「像 Term Grades 的页面」展开（检测到学生卡片 + 多个输入框）。在别的页面会自动收起，内容不丢。

---

## 三、怎么用

> **只在 Term Grades 页面出现。** 脚本的 `@match` 已收窄到 `*/term-grades*`，且面板显示前会再校验一次 URL。
> 实测路由形态（401 = 存在，404 = 不存在）：
> - ✔ `/teacher/classes/<id>/gradebook/term/<termId>/term-grades`
> - ✔ `/teacher/classes/<id>/gradebook/term-grades`
> - ✘ `/teacher/classes/<id>/gradebook/term/<termId>/term_grades`（**下划线是 404**，别写成 `term_grades`）
>
> 若你的实际 URL 不是这个形态，见 §九「如何修改显示范围」。

1. 打开 ManageBac 某个班的 **Gradebook → Term Grades**
2. 面板里点「导入 TermGrades.xlsx」，选你导出的那份表
   - **自动选第 2 张工作表 `Task Categories`**（见下方说明）
   - 自动列出所有可填列（`Intra-Unit Assessment (20%)` / `End of Unit Assessment (20%)` / `Ethos - Attendance & Effort (10%)` / `Mock Exam/Mid-term Exam (25%)` / `End of Term Exam (25%)` / `Target Grade (0%)`）
   - 身份列（Class ID / Student ID / 姓名 / Average / Comments）自动排除
   - 值形如 `C (60.0%)` 时**只取等第 `C`**，百分比丢弃
3. 在「要填的列」里取消你不想动的列（默认全选）
4. **先点「预演」** —— 只匹配不写入，逐条显示「哪个学生 → 哪一列 → 填什么」
5. 确认无误再点「**填入本页**」

### ⚠️ 为什么读第 2 张表（Task Categories）

ManageBac 导出的文件里有**两张**工作表，内容并不相同：

| 工作表 | 内容 | 是否使用 |
|---|---|---|
| 第 1 张 `Term Grades` | 已填好的最终等第快照 | ❌ **跳过**（填回去不会有任何变化） |
| 第 2 张 `Task Categories` | 各评分项的**实际分类成绩**（等第 + 百分比） | ✅ **脚本读这张** |

两者数值确实不同，例如 Jia Qinghan：

| 项目 | 第 1 张表 | 第 2 张表 |
|---|---|---|
| Intra-Unit Assessment | `E` | `U (36.9%)` → 填 `U` |
| Ethos | `N/A` | `D (50.0%)` → 填 `D` |

脚本按工作表**名字**识别 `Task Categories`，不依赖它在第几个。若某次导出没有这张表，会退回使用唯一/最后一张，并在日志里明确提示 ⚠。

### 页面一次只显示一个学生时

如果 Term Grades 页是「点学生名字才显示他那一张卡片」，用「**自动跟随**」：

1. 先导入表
2. 点「自动跟随：关」→ 变成「自动跟随：开」
3. 你正常点下一个学生，脚本会自动把这一张卡片填好

---

## 四、面板上的其他按钮

| 按钮 | 用途 |
|---|---|
| 预演 | 只匹配不写，核对用。**建议每次都先跑一遍** |
| 填入本页 | 真正写入（带回读校验） |
| 自动跟随 | 单学生视图下，切到谁就填谁 |
| 点选绑定 | 自动对不上列时，手动指定「这个输入框 = 哪一列」。绑定会记住 |
| 探查结构 | 把页面真实 DOM 结构导出成 JSON 到剪贴板（排查用） |
| 清空 | 清掉本次导入的表（不影响已记住的绑定） |

---

## 五、它是怎么认出「谁对应谁」的

1. 表里每个学生 → 组合出多种姓名写法（`Pref First Last` / `First Last` / `Last First` / 仅名 / 仅姓 / 中文名）
2. 页面上每个学生卡片 → 从姓名链接往上找到「只含他一个人」的最小容器
3. 两边按宽松打分匹配：英文名完全一致 100 分 → 词全命中 90/80 → 单名 70 → 包含关系 60
4. **最高分并列（同名多人）→ 直接跳过并报出来**，绝不猜

列的对应用的是「表头文字 ↔ 页面标签」的相似度，并内置同义词表：

- `Mid-term/Mock` ≡ `Mock Exam/Mid-term Exam`
- `Ethos` ≡ `Ethos - Attendance & Effort`
- 等第值 `C (60.0%)` 也能在下拉里匹配到 `C (60%)`

---

## 六、安全设计

- **默认跳过 `N/A` 与空值** —— 不会把空值写成 0
- **每格回读校验** —— 写完读回来看是否真的进去了；不一致会报 ❌ 并自动补写一次
- **下拉先查选项** —— 值不在下拉里就报错并列出可选值，不会乱选
- **预演先行** —— 真正的写操作永远在你确认之后
- 写值走「真实输入」路径（`execCommand('insertText')` + 原生 setter + `input`/`change` 事件 + `blur`），因为 ManageBac 的分数框是受控组件，直接改 `.value` 会让框架内部状态不变、提交给服务端的仍是旧值

---

## 七、已知限制

- 页面 DOM 结构未知处（Term Grades 具体控件 id/class）用**语义锚点**推断：姓名链接 → 卡片容器 → 容器内控件 + 标签文本。首次使用建议先「预演」，若列对不上就用「点选绑定」。
- 若你的页面里学生名字**不是** `/teacher/users/<id>` 或 `/teacher/students/<id>` 链接，卡片识别会失败 —— 点「探查结构」，把 JSON 发出来即可适配。
- 自动跟随每 1.2 秒检查一次当前显示的学生，切换后自动填。

---

## 八、出问题时

| 现象 | 处理 |
|---|---|
| 面板不出现 | 先看 URL 是不是 `.../term-grades`（见 §九）；再确认脚本已启用；刷新一次 |
| 「没识别到学生卡片」 | 页面没加载完（等几秒再试），或姓名不是标准链接 → 用「探查结构」 |
| 某列一直对不上 | 用「点选绑定」手动指定一次，之后会记住 |
| 回读 ❌ | 等几秒再点一次「填入本页」（重复填同值是安全的） |
| 下拉 ❌「没有该选项」 | 面板会列出可选值，按它调整导出表里的写法 |

---

## 九、如何修改显示范围（只在 term-grades 页显示）

显示范围由**两处**共同决定，两处都改才最干净：

### 1）脚本头部 `@match`（决定脚本在哪些页面被注入）

文件开头第 6–7 行：

```js
// @match        https://*.managebac.cn/*/term-grades*
// @match        https://*.managebac.com/*/term-grades*
```

`@match` 只支持 `*` 通配，不支持正则。常用改法：

| 想限制为 | 写法 |
|---|---|
| 仅 `.cn`，不限子域，路径含 term-grades | `https://*.managebac.cn/*/term-grades*`（当前） |
| 只匹配带 termId 的完整形态 | `https://*.managebac.cn/teacher/classes/*/gradebook/term/*/term-grades*` |
| 只匹配不带 termId 的形态 | `https://*.managebac.cn/teacher/classes/*/gradebook/term-grades*` |
| 两个形态都要 | 上面两行都写上 |
| 只允许某个学校 | 把 `*.managebac.cn` 换成 `dtd.managebac.cn` |

> ⚠️ 注意是 **`term-grades`（连字符）**，不是 `term_grades`（下划线）—— 后者实测是 404。

### 2）脚本内部的 URL 判定（决定面板显示还是收起）

约在文件末尾「面板存活 / 只在 Term Grades 页展开」一段，找到这个函数：

```js
const onTermGradesUrl = () => /term-grades/i.test(location.pathname + location.search);
```

把正则换成你要的即可，例如：

```js
// 只要带 termId 的形态
const onTermGradesUrl = () => /\/gradebook\/term\/\d+\/term-grades/i.test(location.pathname);

// 只要不带 termId 的形态
const onTermGradesUrl = () => /\/gradebook\/term-grades/i.test(location.pathname);

// 两种都要（默认，等价于现在）
const onTermGradesUrl = () => /\/gradebook\/(term\/\d+\/)?term-grades/i.test(location.pathname);
```

**为什么两处都要**：`@match` 只在页面加载时判断一次，而 ManageBac 是客户端路由（点链接换页不重新加载脚本）。所以 `@match` 放宽一点、让脚本先进来，再由内部的 `onTermGradesUrl()` 在每次路由变化时实时决定显不显示 —— 这样你在 ManageBac 里点来点去，面板也能正确地出现/消失。

改完记得在 Tampermonkey 里保存（Ctrl+S），然后**刷新页面**。
