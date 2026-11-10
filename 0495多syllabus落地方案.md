# 0495 多 syllabus 落地方案（草案 v4）

> 日期：2026-11-10　状态：**方案已定稿，阶段 A/B 已实施**（实施进度见 §九）　上位文档：`多科目架构与Subject Manifest草案.md`（2026-09-08）
>
> **v4 相对 v3 的两处变更**（依据 2026-11-10 第三轮答复与实施实测）：
> 1. **D1 直接落地**（你说「至少要做到 D1」）：`vocab_releases` 按 syllabus 隔离 + `(syllabus, version)` 唯一约束 + 覆盖层表 `vocab_overrides` + 属主级 RLS + 开发者后台账户面板。原 v3 的「本轮走 D0」作废。
> 2. **补充词条 125 → 122 条**：与云端 v100（902 条，比内置 JSON 多 13 条修订）对拍后发现 `Age`、`Social identity`、`Role allocation` 云端已有，剔除。**发布 v101 后的实测终值**：0495 词库 **732 条**（共享 P1–P3 610 + 0495 专属 122），Paper 1 = **400**、Paper 2 = **332**（v4 起草时按内置 889 条算出的 719 / 393 / 326 作废）。
>
> **v3 相对 v2 的三处变更**：
> 1. **复用优先原则收紧**——「能复用现有词条的我都倾向于复用，**包括翻译和释义**」。据此 10 条 glossary 术语不再新增（见 §2.3），补充数 135 → **125**（v4 再降到 122）；新增词条的中文一律沿用现有词库用词（`定性/定量` 而非 `质性/量化`，`可操作化` 而非 `操作化`）。
> 2. **`patterns` 译名定为「规律」**，`operationalisation` 沿用现有 `Operationalise` 的「使…可操作化」。
> 3. **新增 §3.6 教师权限模型**——核实「同事注册教师后能否用教师后台编辑」时发现：现有教师权限是**全局通权**，不存在「各管各的」这层隔离。这直接改变阶段 D 的定位，见该节。
>
> **v2 相对 v1 的四处变更**：
> 1. **犯罪单元本轮不做**——「实操中是不上的，不急着补」⇒ 0495 P2 只含家庭 + 教育，犯罪 topic 连占位都不建。
> 2. **27 条「社会理论」归入身份**——「理论词条按照 0495 大纲应该更接近于身份单元」⇒ 身份 143 → 170。
> 3. **阶段 D（云端隔离）保留**，结论从「永久不做」改为「延后但必做」——理由是 0495 教学任务未来可能换教师承接，需要保留「0495 有自己的词汇」的能力。
> 4. **glossary 从「筛选参考」升级为「补齐来源」**——规则：现有词库有就用现有的，没有就按官方 glossary 补。实测可补 **135 条、未分类 0 条**。

---

## 一、目标与非目标

### 目标

1. 一个 0495 班的学生登录后，看到的词库、卷、topic、练习全部按 **0495 的两卷结构**呈现，且不再出现 Paper 4。
2. 9699 班的行为**零变化**——包括词库条数、本地缓存、进度、错题本。
3. 词条本体（`VocabItem` 的 `paper`/`category`/`unit`/`id`）**不改**，0495 是**运行时投影**。
4. 现有 9699 词条的释义、中文、别名、关系直接复用；只有 glossary 有、词库没有的词才新写。
5. 0495 词库覆盖 0495 官方 glossary 的全部非犯罪术语（331 − 39 犯罪/惩罚 = 292 条，全部可见）。

### 非目标（本次明确不做）

- ❌ `src/subjects/` 目录、`manifest.ts` 自动注册、`import.meta.glob`
- ❌ psychology / economics 等其他 subject
- ❌ 教师端「课程结构管理」CRUD
- ❌ 把 `subject` 塞进 `stableId`（原草案阶段 3，本次不做）
- ❌ 重写现有 889 条词条的任何字段
- ❌ 犯罪 / 越轨 / 社会控制单元（本轮排除，见 §3.5）

---

## 二、内容层：0495 词库怎么组

### 2.1 卷结构（已按 2025–2027 官方大纲核实）

| | 0495 Paper 1 | 0495 Paper 2 |
|---|---|---|
| 时长/分值 | 2h / 80 分 / 50% | 1h45m / 80 分 / 50% |
| 题量 | 3 题各 40 分，**Q1 研究方法必答**（含 data response），Q2 身份 / Q3 分层 二选一 | 3 题选 2 |
| 内容 | 研究方法 + Identity: self and society + Social stratification and inequality | Family + Education + **Crime, deviance and social control** |

> 0495 与 2251（O Level）共用同一结构与大纲。犯罪是本轮唯一空出的官方 topic。

### 2.2 卷结构映射（修正草案的错误假设）

| 0495 | ← 9699 来源 | 现有条数 |
|---|---|---|
| Paper 1 | `Paper 1` 全部（研究方法 + 身份 + 分层 + 社会理论） | 309 |
| Paper 2 | `Paper 2`（Family）+ `Paper 3`（Education） | 288 |
| — | `Paper 4`（Globalisation / Media）**不进入 0495** | 排除 292 |

草案原写的「0495 P2 = 9699 P2+P3，去掉 P4」**结论对、理由错**：P2 合并 P2+P3 是对的，但漏了 0495 P2 还有犯罪单元；0495 P1 也不是 9699 P1 的一部分，而是**全部**。

### 2.3 补齐算法（glossary 怎么参与）

**规则（你提的那条，确认可行）**：
> 术语在**现有词库**里能找到 → 用现有词条（释义、中文、别名、关系全部复用）；找不到 → 判定是否属 0495 考试范围，属则从官方 glossary 补一条新词条。

**术语归一化口径**（决定命中数，必须定死）：

```
1. 小写
2. 去括号内容          "(social)" → " "
3. 斜杠 → 空格         "family/household" → "family household"
4. & → and
5. 非字母数字 → 空格
6. 去虚词 of / the / a / an / and
7. 空白折叠
8. 词尾单复数归一       "households" → "household"、"families" → "family"
```

> 第 8 步是关键：`Single person household` ↔ `Single-person household`、`Co-educational schools` ↔ `Co-educational school` 靠它才对得上。用弱口径（只 trim+lower）只能命中 133 条，用本口径命中 **157 条**。
>
> 近似模糊匹配（token 子集）在此口径上**收益为 0**（0 条新增）⇒ 精确归一已足够，不需要模糊匹配。

**实测结果（node 直读两文件，可复算）**：

| 指标 | 数值 |
|---|---|
| glossary 总条数 | 331 |
| 现有词库已覆盖（归一化命中） | 157（146 落在 P1/P2/P3 + 11 只在 P4） |
| 人工判定可复用、不再新增 | **+10**（见下） |
| 犯罪 / 惩罚类剔除（本轮不上） | 39 |
| **需从 glossary 补** | **125** |
| 未分类 / 无法归属 | **0** |
| 校验 | 167 + 39 + 125 = 331 ✅ |

**归一化未命中、但人工判定「现有词条已覆盖，不新增」的 10 条**（依据「能复用就复用，包括翻译和释义」）：

| glossary 术语 | 复用现有词条 | 判定理由 |
|---|---|---|
| Ethical issues | `Ethics` 研究伦理学 | 同义，0495 不做单独的 ethical issues 词条 |
| Objectivity | `Objective` 客观的 | 形容词/名词同源 |
| Observer effect | `Hawthorne effect (observer effect)` 霍桑效应（观察者效应） | 现有词条已含该别名 |
| Operationalisation | `Operationalise` 使…可操作化 | 同一概念的名词/动词形 |
| Qualitative data / research | `Qualitative research methods` **定性**研究方法 | 现有词条已覆盖数据类型含义 |
| Quantitative data / research | `Quantitative research methods` **定量**研究方法 | 同上 |
| Subjectivity | `Subjective` 主观的 | 形容词/名词同源 |
| Questionnaire | `Postal questionnaire` 邮寄问卷 | 你定：只留现有 postal 版，不新增上位概念 |
| Primary data | `Primary (first-hand) research` 一手研究 | 你定：现有就够了 |
| Secondary data | `Secondary research` 二手研究 | 你定：现有就够了 |

> 保留新增的只有 `Sample`（你定：与 `Sample attrition` 是不同概念，两者都保留）。

⇒ 补充数 **135 − 10 = 125 条**，其中研究方法 32 → **22**，其余 topic 不变（身份 52 / 分层 13 / 家庭 21 / 教育 17）。

**0495 词库终值 = 610（云端 v101 里共享的 P1+P2+P3）+ 122（glossary 补充）= 732 条**。

> ⚠ 数字更新（2026-11-10 实施期实测）：补充数由 125 再降到 **122** —— 与云端 v100（902 条，比内置 JSON 多 13 条修订）对拍后发现 `Age`、`Social identity`、`Role allocation` 三条云端已有（其中 `Role allocation` 与 9699 的 `Functional importance` 同义），已剔除。连带：身份 52 → **49**，P1 补充 84 条。
> **发布 v101 后的真实终值**（`syllabus-projection-selftest.mjs` 实测，脚本输出即权威）：共享 P1+P2+P3 = **610**、0495 专属 **122**、合计 **732**；投影后 Paper 1 = **400**、Paper 2 = **332**。早期按内置 889 条算出的 597 / 719 / 393 / 326 都已作废（云端比内置多 13 条修订）。

> 对比：只做纯过滤（口径 A）会只剩 137~146 条，练习题库撑不起来；补齐后 732 条，密度接近现有 9699 的水平。

### 2.4 补充词条的 topic 归属

按关键词规则 + 人工 override 归属（`page` 字段**不可用**——glossary 的 page 只是按字母排序的分页，p3=A、p4=Ca、p5=Co，19 个取值 3–21，各 topic 的 page 分布完全交叠）：

| 0495 topic | 落在 | 补充（v4） | 发布 v101 后实测 |
|---|---|---|---|
| 研究方法 | Paper 1 | 22 | 79 → **101** |
| 身份与自我 | Paper 1 | 49 | 174 → **223** |
| 社会分层与不平等 | Paper 1 | 13 | 63 → **76** |
| 家庭 | Paper 2 | 21 | 161 → **182** |
| 教育 | Paper 2 | 17 | 133 → **150** |
| 犯罪（本轮不做） | Paper 2 | — | 0 |
| **合计** | | **122** | **732** |

**对拍校验（发布 v101 后实测）**：Paper 1 = **400**；Paper 2 = **332**；400 + 332 = **732** ✅
（脚本 `app/scripts/syllabus-projection-selftest.mjs` 输出即权威：`共享 P1+P2+P3 = 610，0495 专属 122，合计 732`。）

> 表中 9699 侧基数（174 / 63 / 161 / 133）是**云端 v101 的口径**，与更早按内置 889 条算的 170 / 60 / 159 / 129 不同——差的那 13 条就是云端多出来的修订。别再拿内置 JSON 的数字对账。

**中间产物**（`app/scripts/`，除标注外均已产出）：
- `_0495_supplement.json` — **122 条** `{term, topic, definition}`，英文释义**逐字取自**官方 glossary
- `_0495_vocab_items.json` — **122 条完整 `VocabItem`**（含 6 位短译名、paper/category/unit/syllabus），待发布
- `_0495_chinese_notes.json` — 中文完整解释原文（`{term, chinese, note}`），备查用，不进词库
- `_0495_reuse_skipped.json` — 3 条「云端已有」剔除记录（Age / Social identity / Role allocation）
- `_0495_crime_skipped.json` — 39 条剔除清单（留档，将来要补犯罪时直接接上）
- `_0495_supplement_draft.json`、`_0495_supplement_135_backup.json` — 旧版，可删

### 2.5 边界情况：11 条「只在 Paper 4」的术语

这 11 条术语在现有词库里**有**，但挂在 `Paper 4`（0495 不显示 P4）：

> Colonialism、Corporate crime、Cybercrime、Fatalism、Green crime、Hate crime、Institutional racism、Deviancy amplification、Surveillance（+2）

按规则字面执行 = 「现有词库有 → 不补」，但它们不会出现在 0495 视图里，等于 0495 看不到。其中 `Institutional racism`、`Surveillance`、`Fatalism` 对 0495 的身份/分层单元是有用的。

**已实现的做法**：`syllabus.ts` 的 0495 定义里带 `borrowTerms`（`Institutional racism`、`Surveillance`、`Fatalism` 等）——这些词条**不复制、不改字段**，只是在 0495 视图里放行（词条 id 与 9699 完全一致，进度仍互认）。实现上就是 `itemBelongsTo` 里的一段白名单判断。

> 若你觉得麻烦，也可以直接接受「这 11 条 0495 看不到」——它们不是 0495 的核心考点。

### 2.6 犯罪单元：本轮排除

你已定「实操中是不上的，不急着补」⇒
- 0495 P2 只含**家庭 + 教育**两个 topic；
- 不建犯罪 topic、不写犯罪词条、不留空占位；
- 39 条犯罪/惩罚术语的剔除清单留档（`_0495_crime_skipped.json`），将来要补时直接接着做。

> 副作用提醒：0495 P2 官方是「3 题选 2」，学生若真考到犯罪题会没学过。若这一届学生确定不选犯罪题，无影响。

### 2.7 中文释义缺口（唯一的内容工作量）

| 范围 | 缺中文 | 说明 |
|---|---|---|
| 0495 现有 597 条 | 148 条（**全部是 scholar**，term 类 0 条） | 历史遗留，9699 也一样缺，非本次引入 |
| glossary 补充 122 条 | **122 条全缺**（都是 term） | 本次要写 |

⇒ 本次真正的新增写作量 = **122 条中文**（英文已从官方 glossary 逐字取）。**已完成**：分两批发给 `zh-translator` 写，产出 `0495补词与中文释义-待审.md`（methods 22 条）+ `0495补词与中文释义-第2-5批.md`（identity 49 / family 21 / education 17 / strat 13）；逐行脚本比对了 term 顺序与 definition 原文（missing 0 / diff 0）。

> 一个实施期的口径修正：译文中「**术语名**：解释」的整段不能直接塞进 `VocabItem.chinese`——现有 889 条的 `chinese` 一律是短译名（平均 4.8 字），而且被 `quiz.ts` 当「看中文说术语」的题干、被 `Flashcards` 当背面大字、被 `answers.ts` 当可接受答案。所以只取冒号前的术语名入库（平均 4.2 字、最长 7 字），完整解释另存 `_0495_chinese_notes.json` 备查。

---

## 三、架构层：syllabus 适配层

### 3.1 与草案的偏离（四处简化/调整）

| 草案 | 本方案 | 依据 |
|---|---|---|
| `src/subjects/` + `manifest.ts` + `import.meta.glob` 注册 | `app/src/lib/syllabus.ts` 里一个常量表 | 只做 0495。全仓零处 `import.meta.glob`，引入即增加构建风险 |
| 本地缓存 key 加 syllabus 维度 | **不加**（见 §3.4） | 数据同源，只有视图不同 |
| release 按 syllabus 过滤 + 版本号隔离 | **延后到阶段 D，但保留必做** | 本轮无第二份 release；但 0495 未来可能换教师、可能长出独立词库，隔离能力必须留 |
| — | **新增**：glossary 补齐流水线 | v2 的新内容来源 |

### 3.2 数据结构

```ts
// app/src/lib/syllabus.ts —— 实际实现（与本节草案的偏离见下方说明）
export type SyllabusId = '9699' | '0495';

export interface SyllabusPaper {
  id: string;         // 内部稳定 id
  tag: string;        // 展示名，如 'Paper 1'
}

export interface SyllabusDef {
  id: SyllabusId;
  label: string;
  papers: SyllabusPaper[];
  paperMap: Record<string, string>; // 词条原生 paper → 本 syllabus 的卷 id
  borrowTerms?: string[];
}

export const SYLLABI: Record<SyllabusId, SyllabusDef>;
export const DEFAULT_SYLLABUS: SyllabusId = '9699';
export function getSyllabus(id?: string | null): SyllabusDef; // 未知 id 回落 9699

// 投影：只改 paper 字段与可见性，id/term/category/unit 全不动
export function projectItems(items: VocabItem[], s: SyllabusId): VocabItem[];
export function papersFor(s: SyllabusId): string[];
export function itemBelongsTo(item: VocabItem, s: SyllabusId): boolean;
```

**9699 的定义**（必须与现状完全等价）：

```ts
9699: {
  id: '9699',
  label: 'Cambridge 9699 (A Level)',
  papers: [p1, p2, p3, p4],
  paperMap: { 'Paper 1': 'p1', 'Paper 2': 'p2', 'Paper 3': 'p3', 'Paper 4': 'p4' }, // 恒等
}
```

**0495 的定义**（含 v2 决定：理论归身份；无犯罪）：

```ts
0495: {
  id: '0495',
  label: 'Cambridge 0495 (IGCSE)',
  papers: [ { id: 'p1', tag: 'Paper 1' }, { id: 'p2', tag: 'Paper 2' } ],
  paperMap: { 'Paper 1': 'p1', 'Paper 2': 'p2', 'Paper 3': 'p2' }, // 教育归入 P2；Paper 4 缺席
}
```

> **与 v3 草案的两处偏离（实施时改的，理由更重要）**
> 1. **不建 `topics` 数组，也不建 `excludeCategories`。** 改用 `VocabItem.syllabus?: string` 标记归属：不填 = 所有大纲共享；填 `'0495'` = 只在 0495 视图出现。原因：用 `category:'0495'` 打标会让 122 条补充词条自成一组「0495」主题，没法与家庭/教育等既有主题合并；而 `syllabus` 字段不进 `stableId`，同名词条跨大纲 id 仍然相同。
> 2. **topic 归属不走 `SyllabusTopic.units` 交集，直接沿用 9699 的 `unit` 名。** 补充词条的 `unit` 在组装时就按 topic 语义写入既有 unit（研究方法 16 / 教育功能 17 / 家庭多样性 21 / 阶级认同 13 / 社会认同基础 42 / 性别认同 5 / 族裔认同 1 / 年龄认同 1 / 研究设计 6），因此 0495 的分组排序完全复用现有 `UNIT_ORDER` 逻辑，无需新映射。

### 3.3 投影规则（关键不变量）

**规则 1：投影发生在「视图层」，不发生在「数据层」。**

```ts
export function projectItems(items: VocabItem[], s: SyllabusId): VocabItem[] {
  if (s === DEFAULT_SYLLABUS) {
    // 快路径：没有任何专属词条时返回同一引用（保证 memo/effect 不反复触发）
    return items.some((i) => !itemBelongsTo(i, s)) ? items.filter((i) => itemBelongsTo(i, s)) : items;
  }
  const out: VocabItem[] = [];
  for (const i of items) {
    if (!itemBelongsTo(i, s)) continue;
    const tag = paperTagFor(i, s);
    if (!tag) continue;                      // 该卷在本 syllabus 不存在（如 Paper 4）
    out.push(tag === i.paper ? i : { ...i, paper: tag });  // 只换 paper 展示名
  }
  return out;
}
```

`store.tsx` 里 `scopedVocab = projectItems(applyVocabOverrides(vocab, overrides), activeSyllabus)`，所有消费词库的组件改读 `scopedVocab`。原有的 `filterByPaperCat` 因此**不需要加 syllabus 参数** —— 传进去的已经是投影后的数据，语义等价且不漏改 22 处调用点。

**规则 2：`VocabItem` 的 `id` 一律不改。**

`stableId(type, term, paper, category, unit)`（`app/src/lib/shuffle.ts`）的输入不变 ⇒ **0495 与 9699 的同源词条 id 完全相同** ⇒ 进度、错题本天然互认，零迁移。`syllabus` 字段刻意不进 key。任何「重算 id」的实现都会破坏它。

**规则 3：`papers` / `categories` 从 syllabus 派生，不再写死。**

```ts
categories = [...new Set(scopedVocab.map(i => i.category).filter(Boolean))].sort();
papers = papersFor(activeSyllabus).filter(p => scopedVocab.some(v => v.paper === p));
```

9699 下结果与改造前完全一致（`PAPER_ORDER` 的四处引用已一并清掉）。

**规则 4：122 条补充词条带 `syllabus: '0495'`。**

```json
{ "paper": "Paper 1", "category": "", "unit": ["社会认同基础"], "syllabus": "0495" }
```

- 对 0495：`itemBelongsTo` 通过 → 正常展示在对应 unit 下；
- 对 9699：`itemBelongsTo` 拒绝 ⇒ 9699 的条数、分组、练习**全部不变**（这是本方案对 9699 零影响的关键）；
- `category` 保持为空串（不是 `'0495'`），这样它们能和 9699 的 P1 词条混在同一个「全部主题」列表里；
- `unit` 复用现有 9699 unit 名（不新造 unit），分组、排序完全走现有 `UNIT_ORDER` 逻辑。

**规则 5：过滤只在一处发生。**

`syllabus.ts` 的 `projectItems` + `vocabOverrides.ts` 的 `applyVocabOverrides` 就是全部逻辑，`store.tsx` 只算一次 `scopedVocab` 往下发。**9699 回归断言**：`syllabus-projection-selftest.mjs` 里 150 个组合逐 id 对拍 + P1 仍 309 条。

### 3.4 缓存与进度：不加 syllabus 维度

草案要求 `storage.ts` 的 `VOCAB_KEY`（`:41`）加 syllabus 维度。**本方案认为不需要**：

- 数据源是同一份 `vocab_releases.data`（含 0495 补充词条），不是两份；
- 0495 与 9699 的差异纯粹是**视图过滤**，缓存同一份完整数据反而更省、更不易脏；
- `scopedKey()`（`storage.ts:60`）的 `base:userid` 结构不必改，影响面小。

**唯一分层的是「当前 syllabus」这个偏好本身**：`socio_active_syllabus`，不参与缓存作用域。

> 触发重新考虑的条件：阶段 D 落地（每个 syllabus 独立 release）时，缓存必须分层。

### 3.5 `activeSyllabus` 从哪来

三级解析，优先级从高到低：

1. **学生所属班级** → `classes.syllabus`（该列已存在，现有 2 班均 `9699`）。当前拿不到，因为 `app/src/lib/cloud.ts` 的 `pullCloudData()` 只 `.select('data')`，需改为 `.select('data, class_id')` 再查 `classes.syllabus`。
2. **本地偏好** → `socio_active_syllabus`（教师切换后记住）。
3. **默认** → `'9699'`。

`getSyllabus()` 对未知/空值一律回落 `'9699'` ⇒ 现有 21 个学生（18 个有 `class_id`、全部 `syllabus='9699'`）行为零变化。

### 3.6 教师权限模型（回答「同事注册教师后能不能编辑」）

**你的问题**：邀请负责 0495 的同事注册教师账号后，他能同样用教师后台手动编辑吗？核验工作能不能交给他？

**核实结论：能编辑，但现在是「全通」——他能编辑你的一切，你也能编辑他的一切。** 逐条证据（2026-11-10 实测）：

| 层 | 现状 | 位置 |
|---|---|---|
| 角色判定 | `roles.includes('teacher')` 即放开全部教师功能，只有 `isTeacher` 一个布尔 | `app/src/lib/store.tsx:175-180` |
| 入口 | 教师面板挂 11 个子面板（查词/班级/测验/分组/成绩/AI 网关/OCR/定义复核/词库/逻辑链/导入），**无按科目分面板** | `App.tsx:555`、`AdminPanel.tsx:153-163` |
| RLS 写策略 | 只判角色、**不判归属**：`EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = auth.uid() AND r.role = 'teacher')` | `classes_write` / `quizzes_write` / `vocab_releases_write` |
| RLS 读策略 | 读全表：`classes_read`/`quizzes_read` = `authenticated`，`vocab_releases_read` = `true` | 同上 |
| 前端查询 | **全部不带属主过滤**：`listClassesWithMb()` 只 `select('id, name, papers, mb_class_url, mb_class_id').order('name')`；`listQuizzes()` 是 `select('*')`；`TeacherCheckPanel` 的 `student_data` 是全表 | `cloud.ts:693`、`cloud.ts:737`、`TeacherCheckPanel.tsx:201,209-212` |
| 写操作 | 建/改/删班不带 `teacher_id` | `ClassManager.tsx:103,118,140` |
| 已有但闲置的属主列 | `classes.teacher_id` **全为 NULL**；`vocab_releases.published_by` **100 行全 NULL**（前端 insert 根本没写）；`quizzes.created_by` 有值但只有 1 个作者 | psql 实测 |

统计口径：全库 **49 条** teacher 门控策略（`ai_gate`/`grouper_runs`/`quizzes`/`vocab_releases`/`vocab_answer_forms`/`question_bank`/`qb_releases`/`ms_sections`/`sim_*`/`live_*`/`mb_*`/`definition_*`/`skill_content`/`student_xp_bonus` 等），**没有一条带 owner / teacher_id / syllabus 过滤**。

**另外两件必须知道的事**：

1. ~~没有角色管理界面~~ → **已解决**：`db-migration-roles-and-ownership.sql` 加了 `admin_search_accounts` / `admin_set_role` 两个 RPC，开发者后台新增「账户与权限」面板。同事自行注册并登录一次后，你在该面板搜邮箱点「设为教师」即可（`teacher_roles` 会同步双写，避免旧策略看不到学生数据）。
2. **两人同时发布会撞版本号**。原先 `vocab_releases` 只有 pkey、**无 version 唯一约束**，版本号由前端 `getLatestVocabVersion() + 1` 现算 ⇒ 你俩几乎同时点发布，会生成两条同 version 的记录。**已修**：加了 `vocab_releases_syllabus_version_key unique (syllabus, version)`，撞号会被数据库直接拒绝（前端报错，不会静默覆盖）。
3. **发布不可撤销**。`vocab_releases` 只有 INSERT 策略，没有 UPDATE/DELETE ⇒ 发错只能再发一版覆盖（历史仍在）。对「两人协作」这点偏安全，对「发错」不友好。

**⇒ 这直接改变阶段 D 的范围。** 原先阶段 D 只是「release 按 syllabus 隔离」，现在必须同时包含**权限隔离**，否则「把核验交给 0495 同事」这件事在权限上不成立 —— 你要么接受他能看到并改动 9699 的全部数据，要么把属主过滤补上。三个可选做法：

| 做法 | 内容 | 成本 | 隔离强度 |
|---|---|---|---|
| D0 约定制 | 不加权限，靠人和约定（`syllabus` 字段 + 各自只碰自己的 syllabus）。先让协作跑起来 | 0 | 无技术保障 |
| D1 发布按 syllabus 隔离 | 三个 cloud 函数加 `syllabus` 维度 + 回落策略 + `vocab_releases` 的 `(syllabus, version)` 唯一约束 + 覆盖层表 `vocab_overrides` + 属主级 RLS 与开发者后台 | 中 | 词库层隔离，班级按教师区分 |
| D2 全库属主级隔离 | 在 D1 之上把剩余 40 余条策略全部改成 owner 过滤（quizzes / question_bank / ms_sections / sim_* / live_* 等） | 大 | 完全隔离 |

**已定的做法（2026-11-10，你说「至少要做到 D1」）**：走 **D1**，并额外做三件配套：
1. **开发者后台账户面板**：`DevPanel` 里新增「账户与权限」，可按邮箱搜索、授予/撤销 `teacher`（`admin_set_role` RPC），并给每个班指定任教教师（`admin_set_class_teacher`）。
2. **班级按教师区分**：`classes_write` 收紧为「本人任教的班」；新建班级自动写 `teacher_id`；开发者不受限。现有 2 个班已回填到你名下。
3. **词库「id 不变、分两版展示」**：不做词条复制。9699 始终是基础词库，0495 教师对某个继承词条的任何改动只写进 `vocab_overrides`（`op` = `edit`/`hide`/`add`，`patch` 只存被改字段），运行时由 `applyVocabOverrides()` 合并。词条 id 全程不变 ⇒ 学生掌握度、错题本、判定表都不需要迁移。
   - 若 0495 教师从未改动某词条，该词条对他就是**投影式复用**（看的是 9699 的原文）；一旦改动，只有 0495 的学生看到改后版本，9699 学生完全不受影响。
   - 「恢复原样」= 删掉那条 override 记录，立即回到 9699 原文。

D2 仍留在 `KNOWN_ISSUES.md` 作为「多教师全面协作」的前置条件。

> 一项遗留不一致：`student_data` 的 `teachers_read_all_students` 策略查的是旧的 `teacher_roles` 表（只有 1 行），而 `student_data_assign_class` 查的是 `user_roles`。同事授予 `user_roles` 后，能看到班级但**看不到学生数据**，需要同步补 `teacher_roles`。这条列入阶段 D 的前置检查。


---

## 四、分阶段任务拆解

> 原则：每阶段独立可验收、可回滚。A、B 完成界面即可看到 0495；C 是正确性；D 是云端隔离（延后，但保留）。

### 阶段 A：syllabus 适配层（行为零变化）

| 项 | 内容 | 状态 |
|---|---|---|
| 新增 | `app/src/lib/syllabus.ts`：类型 + `SYLLABI`（9699 与 0495 都填）+ `projectItems()` + `papersFor()` + `itemBelongsTo()` | ✅ |
| 改动 | `VocabItem` 加 `syllabus?: string`（`app/src/lib/types.ts`） | ✅ |
| 改动 | `app/src/lib/store.tsx` 的 `papers` / `categories` 改从 `scopedVocab` 派生 | ✅ |
| 改动 | `app/src/lib/storage.ts` 加 `ACTIVE_SYLLABUS_KEY` + `loadActiveSyllabus()` / `saveActiveSyllabus()` + `loadVocabVersionFor()` | ✅ |
| **验收** | ① `tsc -b` 通过；② 9699 下 `papers` 仍为 `['Paper 1'..'Paper 4']`；③ 150 个组合逐 id 对拍（`syllabus-projection-selftest.mjs`）**ALL PASS**；④ 界面零视觉变化 | ✅ |

### 阶段 A′：glossary 补齐流水线（内容准备）

| 项 | 内容 | 状态 |
|---|---|---|
| 新增 | `app/scripts/build-0495-supplement.mjs`：读 `_0495_supplement.json` + 两份 md 里的中文 → 组装 122 条完整 `VocabItem` | ✅ |
| 新增 | 122 条词条数据（`paper` / `category:''` / `unit` / `syllabus:'0495'` / 英文释义取自 glossary / 短译名） | ✅ `app/scripts/_0495_vocab_items.json` |
| 校验 | ① 167 + 39 + 122 = 328；② 未分类 0；③ 与云端 v100 零 id 冲突、零重名 | ✅ |
| 注意 | 词条**入库走云端**（以 v100 为基底发布 v101），`vocab-data.json` 只作离线兜底——这是 `project-memory.md` 的既有约定，不能让两份分叉 | ⏳ |

### 阶段 B：0495 投影上线

| 项 | 内容 | 状态 |
|---|---|---|
| 改动 | `syllabus.ts` 的 0495 `paperMap`（Paper 3 → Paper 2） | ✅ |
| 改动 | `app/src/lib/cloud.ts` 新增 `pullStudentSyllabus(userId)`：两步查 `student_data.class_id` → `classes.syllabus` | ✅ |
| 改动 | `store.tsx` 暴露 `activeSyllabus` / `scopedVocab` / `setActiveSyllabus`，10 个练习组件 + Dictionary/Cloze/ConceptMapView/Home 改读 `scopedVocab` | ✅ |
| 改动 | `unitMapping.ts` 的 `unitOrderFor` 加跨卷 category 回退（0495 教育并进 P2 后仍能列单元） | ✅ |
| 改动 | 顶栏/设置页加 syllabus 切换器（对 developer/teacher 可见；学生按班级自动） | ⏳ 待做 |
| **验收** | ① 0495 身份登录：只见 Paper 1 / Paper 2，不见 Paper 4；② P2 下同时出现家庭 + 教育；③ P1 下出现研究方法 / 身份 / 分层；④ **Paper 1 计数 400、Paper 2 计数 332**；⑤ 切回 9699 一切复原（Paper 1 仍 316 条共享）；⑥ 同一词条两 syllabus 下 `id` 相同 | ① ④ ⑤ ⑥ 已由自测脚本覆盖（ALL PASS），②③ 待登录实测 |

### 阶段 C：正确性补完

| 项 | 内容 | 状态 |
|---|---|---|
| 改动 | `app/src/lib/mbSync.ts:45` `gradeFromPapers()` 按 syllabus 分叉：0495 班不做 A1/A2 判定（现逻辑 `max<=2 → 'A1'` 会把 0495 误判成 A1） | ⏳ |
| 改动 | `app/src/lib/cloud.ts:693` `listClassesWithMb()` 的 select 补 `syllabus`（已补 `teacher_id`） | ✅ |
| 改动 | 教师建班/改班可选 syllabus（列已存在，只缺 UI） | ✅ 建班已加下拉，改名未加 |
| **验收** | ① 建 0495 班 → 学生登录即得 0495 视图；② 该班短码不出现 A1/A2 误标；③ 9699 班短码行为不变 | ⏳ |

### 阶段 D：云端隔离（延后，但保留必做）

你已明确「仍有可能需要做」——因为 0495 教学任务未来可能换人承接，0495 可能长出自己的一套词汇。所以本阶段**不做「永久不做」的结论**，只排在最后：

| 项 | 内容 | 状态 |
|---|---|---|
| 改动 | `app/src/lib/cloud.ts` 的 `getLatestVocabVersion` / `pullLatestVocab` / `publishVocab` 加 `syllabus` 维度（`.eq('syllabus', s)`；`nextVersion` 按 syllabus 各算） | ✅ 已实现 |
| 前置 | 必须先解决「0495 查不到 release」的回落：现有 100 行全 `syllabus='9699'`，加过滤后 0495 会空 | ✅ 已实现 |
| 回落策略 | 0495 先查自己的 release，查不到则回落取 9699 的 latest（投影模式），查到则用自己的（独立模式）——**同一套代码同时支持两种模式**，这就是保留灵活性的做法 | ✅ 已实现 |
| 唯一约束 | `vocab_releases_syllabus_version_key unique (syllabus, version)`，堵掉两人同时发布撞号 | ✅ 已上线 |
| 覆盖层 | 新表 `vocab_overrides(syllabus, item_id, op, patch, updated_by, updated_at)` — 「id 不变、分两版展示」的落点 | ✅ 已上线 |
| 权限隔离 | D1 已上线：`classes_write` 收紧为「本人任教的班」、`student_data_assign_class` 双向归属校验、`teachers_read_all_students` 改查 `user_roles`；开发者后台新增账户与班级归属面板 | ✅ 已上线 |
| 剩余 | D2（quizzes / question_bank / ms_sections / sim_* / live_* 等 40 余条策略的属主过滤） | ⏳ 记入 `KNOWN_ISSUES.md` |

---

## 五、风险清单

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | unit 名精确匹配决定分组 | unit 改名/新增 → 分组错 | 补充词条组装时即写入既有 unit 名；对拍脚本锁条数（400 / 332 / 732） |
| 2 | 一条词条挂多个 unit | 分组重复或漏落 | 组装器按 `UNIT_HINTS` 取首匹配，逐条写入单值 unit |
| 3 | 漏改某个消费 `vocab` 的组件 | 该处仍看到 Paper 4 | 已逐个核对 49 处 `useStore()`：按 id 反查的（WrongPractice/CorrectionPractice/QuizWrongBoard/LiveStudent）**故意保留全量**，其余展示型已切 `scopedVocab` |
| 4 | **9699 被补充词条污染** | 9699 用户 Paper 1 突然多出 87 条 | 用 `VocabItem.syllabus` 字段标记归属 + `itemBelongsTo()` 集中过滤 + 9699 回归断言（P1 仍 309） |
| 5 | 122 条补充的 unit 归属靠关键词规则 | 部分词条可能归错单元 | 生成清单后逐条人工过一遍；归错只影响分组不影响可用 |
| 6 | `quizzes` 无 subject/syllabus 列 | 0495 班测验 `papers` 写 `'Paper 2'` 与 9699 语义冲突；成绩聚合可能混卷 | 本次不解决，记入 `KNOWN_ISSUES.md`；0495 班暂不做随堂测验 |
| 7 | 学生 `class_id` 为空（21 人中 3 人） | 这些学生按默认 9699 呈现 | 可接受（现有行为） |
| 8 | 本机数据源与云端词库分叉 | 补充词条若只改 `vocab-data.json`，云端不会更新 | 按约定走云端：以云端 v100（902 条）为基底合并 → 发布 v101 → 再把内置 JSON 同步为同一份 |
| 9 | 与在途未发布改动冲突 | 「另存为补交卷」已实现未发布（`cloud.ts` `duplicateQuiz()` + `QuizManager.tsx`） | 阶段 A 只碰 `CategoryFilter.tsx`/`store.tsx`/`storage.ts`/新文件，与之无交集；开工前确认那批已发布 |
| 10 | 犯罪单元缺席 | 0495 学生若考到犯罪题没学过 | 已知并接受（实操不选该题）；剔除清单留档 |
| 11 | 中文 122 条由 AI 草拟 | 措辞可能与官方表述不符 | 按 `project-memory.md:140` 纪律：英文释义逐字取自官方 glossary，中文只作辅助；已按 topic 分批产出（`0495补词与中文释义-待审.md` + `-第2-5批.md`），等你过目 |

---

## 六、v1 的三个待拍板点（已全部有结论）

| # | 问题 | 结论 |
|---|---|---|
| ① | 犯罪单元本次补 / 留空 / 补最小集 | **本轮不补**，topic 也不建（你：实操中不上） |
| ② | 27 条理论词归哪 | **归身份**，143 → 170（你：按 0495 大纲更接近身份单元） |
| ③ | 阶段 D 做还是永久不做 | **保留必做，排在最后**；回落策略见 §四 阶段 D（你：要保留换教师接入的灵活性） |

---

## 七、全部决策点已锁定（2026-11-10）

| # | 问题 | 结论 |
|---|---|---|
| ① | 125 条补充的中文释义怎么过 | **按 topic 分批给你过目**（每批 30 条左右），确认后才入库 |
| ② | 11 条「只在 Paper 4」的术语 | **用 `borrowTerms` 放行**（词条不动、id 不变、进度仍互认） |

至此 v1/v2 的五个待拍板点（犯罪 / 理论归属 / 阶段 D / 中文流程 / P4 术语）全部有结论。v3 新增的两个问题（复用翻译口径、教师权限模型）也已落到 §2.3 与 §3.6。v4 按 2026-11-10 的决定调整为：**D1 直接落地**（含开发者后台账户面板、班级按教师区分、`vocab_overrides` 覆盖层），**D2 记入 `KNOWN_ISSUES.md`**。

---

## 八、实施进度（2026-11-10）

| 项 | 状态 |
|---|---|
| `src/lib/syllabus.ts` 适配层（`SYLLABI` / `projectItems` / `papersFor` / `itemBelongsTo`） | ✅ |
| `VocabItem.syllabus` 归属字段 | ✅ |
| store 暴露 `activeSyllabus` / `scopedVocab` / `setActiveSyllabus` | ✅ |
| 学生→班级→syllabus 解析（`pullStudentSyllabus`） | ✅ |
| 10 个练习组件 + Dictionary/Cloze/ConceptMapView/Home 切 `scopedVocab` | ✅ |
| `cloud.ts` 三函数按 syllabus 分叉 + 回落 | ✅ |
| `unitMapping` 跨卷 category 回退（0495 教育并进 P2） | ✅ |
| `vocabOverrides.ts` 覆盖层合并 + store API | ✅ |
| `VocabManager` 归属大纲表单 / 已改写标记 / 恢复原样 / 继承词条改写走覆盖层 | ✅ |
| `ImportPanel` 发布与恢复按 syllabus 分叉 | ✅ |
| `db-migration-roles-and-ownership.sql`（权限 + 覆盖层表 + 唯一约束 + 3 个 RPC） | ✅ 已应用 |
| `AccountsPanel`（开发者后台账户与班级归属） | ✅ |
| 122 条补充词条组装（`_0495_vocab_items.json`，0 冲突 0 重名） | ✅ |
| 9699 回归 + 0495 投影自测（`syllabus-projection-selftest.mjs`，ALL PASS） | ✅ |
| **122 条发布进云端 v101 + 同步内置 `vocab-data.json`** | ✅ v101 已上生产（1024 条 / 430912 字节），内置 JSON 同步 |
| **`mbSync` 的 0495 年级位分叉（`Grade` = `A1/A2/G1/G2`）** | ✅ `db-migration-run-syllabus.sql` 已应用；`grouper_runs` / `quizzes` 加 `syllabus` 列；`inferGrade` / `gradeFromPapers` / `gradeForRun` / 两个短码函数全部分叉。**0495 用 G1/G2 且不自动推断**（P1、P2 同一张证书，卷号推不出年级）⇒ 对 0495 返回 `null`，年级下拉首项为 disabled 的「年级…」、按钮 `disabled={!grade}`，等教师手选 |
| **顶栏/账户菜单的 syllabus 切换器** | ✅ 账户菜单「词库视图」段，仅教师可见 |
| **D2 属主级隔离记入 `KNOWN_ISSUES.md`** | ✅ 第 5 条 |
| `VocabManager` 列表「归属」列（共享 / xx 专属） | ✅ |

**仍未做（下一批）**：
- 端到端实测：用 0495 班学生登录，确认只见 P1/P2、P2 下家庭 + 教育并列、切回 9699 复原。
- 教师端「0495 词库视图」下改一条继承词条 → 确认写进 `vocab_overrides` 且 9699 视图不受影响（该表目前 0 行，尚未有真实写入）。
- 提交与发布：这批改动尚未 commit；发布时版本号从 `96` 起，并把「另存为补交卷」一并带上。

**已知小瑕疵（不阻塞）**：
- `VocabManager` 的「考卷」下拉仍给四卷（`PAPER_ORDER`），0495 教师理论上可把词条挂到 Paper 4 —— `projectItems` 会在 0495 视图里过滤掉，不会显示，但数据上不干净。
- `DefinitionPractice` 仍用 `PAPER_ORDER` 过滤，不过它按实际词条现算裁剪，0495 下自动只剩两卷，无可见问题。
- `excelImport.ts` 的 `CATEGORY_TO_PAPER` 平行副本未按 syllabus 分叉（Excel 导入路径，0495 教师当前不使用）。

---

## 九、开工前检查清单

- [ ] `进行中.md` 里的「另存为补交卷」是否已发布（避免 Git 冲突）
- [ ] 确认线上版本号（当前 `95 / 1.12.3`，下一批从 `96` 起）
- [ ] 确认本次不开 `app/src/subjects/`、不动 `stableId`、不动 9699 的缓存 key
- [ ] 122 条入库前先备份 `vocab_releases` 最新行（`version=100`，902 条）— **已做，v101 已发布**
- [x] D1 的 `(syllabus, version)` 唯一约束（已上线，两人同时发布会报错而非静默覆盖）
- [x] 教师角色授予不再需要 SQL：开发者后台「账户与权限」面板（`teacher_roles` 与 `user_roles` 同时写）
- [ ] 9699 回归基线先量好：P1 = 309 / P2 = 159 / P3 = 129 / P4 = 292，合计 889（云端 v100 为 902 条，多了 13 条修订）— **v101 后的实测基线是共享词条 P1 = 316 / P2 = 161 / P3 = 133 / P4 = 292，合计 902**
