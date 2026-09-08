# 多科目架构与 Subject Manifest 草案

> 状态：草案（设计讨论中，未落地）
> 本文回答三个问题：subject 层怎么组织、科目如何「注册」、从现状平滑过渡的路径。
> 关联文档：`用户分类管理方案.md`（角色/班级）、`词库上云与同步方案.md`（release）、`db-migration-syllabus.sql`（syllabus 列，已备好）

## 一、目标与非目标

### 目标
1. 支持未来加入心理学/经济学等科目，加科目**不改核心代码**（注册制而非硬编码）
2. 同一科目内支持多 syllabus（如社会学 9699 / 0495），0495 可**从 9699 派生**（排除规则 + paper 合并），重叠词进度共享
3. 不同科目之间数据/进度/发布链**彻底隔离**；跨科目词面重叠永不碰撞
4. 与学生账号归属（可同时属多科）、班级、测验等现有结构兼容
5. 从现状到多科目**分阶段平滑过渡**，每阶段可独立交付、不回退

### 非目标（不做，避免过度设计）
- 不做「科目插件化」：不为每个科目写独立 import 管线/组件框架
- 不做任意科目可编程扩展 schema（核心 `VocabItem` 保持单份稳定形状）
- 不做跨科目进度共享的通用机制（如将来确实需要，用显式 cross-subject 映射表，独立增量）

## 二、概念与层级

```
subject（科目）           sociology │ psychology │ economics   ← 注册粒度，代码按目录自动发现
  └─ syllabi（大纲）      9699 / 0495                            ← subject 内的视图/派生
       └─ release 链      vocab_releases.subject=…               ← 每 subject 独立版本号
             └─ 词条      id 含 subject，不含 syllabus           ← 隔离与共享的边界
```

| 维度 | 例子 | 特征 |
|---|---|---|
| subject | 社会学 / 心理学 | 独立词库、进度、release、题库；跨科不共享 |
| syllabus | 社会学下 9699↔0495 | 同科变体；0495 = 9699 的派生视图，重叠词进度共享 |

**进度共享只发生在「同一 subject 内」**：`stableId` 输入含 subject（新增）但不含 syllabus（保持），因此 9699 与 0495 的同源词条 id 一致、进度天然互认；而跨科目因 subject 前缀不同永不碰撞。

## 三、Subject Manifest 数据形状

采用**目录约定 + manifest.ts 自描述**，用 `import.meta.glob` 自动发现，加科目＝加目录 + manifest。

```ts
// src/subjects/registry.ts
const manifests = import.meta.glob('./*/manifest.ts', { eager: true, import: 'default' })
  as Record<string, SubjectManifest>;
```

```ts
// src/subjects/types.ts
export type SubjectId = 'sociology' | 'psychology' | 'economics' | (string & {});

export interface SubjectManifest {
  id: SubjectId;
  label: string;
  // 词条 schema 开关：该科目是否有学者人名维度（决定导入列/展示形态）
  hasScholars: boolean;

  // 科目内大纲定义
  syllabi: Record<string, SyllabusDef>;
}

export interface SyllabusDef {
  label: string;                 // 显示名，如 'A Level 9699'
  // 该大纲自身展示的卷（顺序/内部 key/nominal tag 在此声明，不与词条 paper 硬耦合展示）
  papers: { id: string; tag: string }[];

  // 内容来源：独立词库 or 派生
  source: 'own' | 'derive';
  deriveFrom?: string;           // source=derive 时，指同 subject 内上游 syllabus id
  rules?: DeriveRules;           // 派生规则（仅 derive 需要）
}

export interface DeriveRules {
  // 卷合并：0495 的 Paper 2 = 9699 的 Paper 2 + Paper 3
  mergePapers?: Record<string, string[]>;
  excludePapers?: string[];      // 如 0495 无 Paper 4
  // 排除：整单元 或 单元内个别词条（按 stableId / term 匹配）
  excludeUnits?: string[];       // 上游单元名黑名单
  excludeTerms?: { unit?: string; ids?: string[] }[]; // 按上游 id 精确排除
}
```

manifest 示例（sociology，0495 作为派生大纲）：

```ts
// src/subjects/sociology/manifest.ts
export default {
  id: 'sociology',
  label: 'Sociology',
  hasScholars: true,
  syllabi: {
    '9699': {
      label: 'A Level 9699',
      source: 'own',
      papers: [
        { id: 'p1', tag: 'Paper 1' },
        { id: 'p2', tag: 'Paper 2' },
        { id: 'p3', tag: 'Paper 3' },
        { id: 'p4', tag: 'Paper 4' },
      ],
    },
    '0495': {
      label: 'IGCSE 0495',
      source: 'derive',
      deriveFrom: '9699',
      papers: [
        { id: 'p1', tag: 'Paper 1' },
        { id: 'p2', tag: 'Paper 2' },   // = 9699 Paper 2 + 3
      ],
      rules: {
        mergePapers: { p2: ['p2', 'p3'] },  // 内部 id 对应上游
        excludePapers: ['p4'],
      },
    },
  },
} satisfies SubjectManifest;
```

> 注：`papers[].id` 使用 subject 内稳定的内部卷 id（如 `p1/p2/...`），`tag` 才是展示名。这样 0495 的「Paper 2」与 9699 的「Paper 2」在 UI 上同名但在内部清晰区分，规避词条 `paper` 字段值域与展示结构的强耦合。

## 四、科目内容资产的归属

「注册制」的本质是把**科目专属内容从代码/全局 JSON 中归类到 subject 名下**。当前全部分布如下（均属 sociology/9699）：

| 现状资产 | 现状位置 | 未来归属 |
|---|---|---|
| 内置词库 | `public/vocab-data.json` | sociology 9699 基线内容 |
| 词条→unit 映射 | `src/lib/unit-mapping.json` | sociology 内容 |
| 可接受别名 | `src/lib/answer-aliases.json` | sociology 内容 |
| 主题→paper 映射（旧） | `unitMapping.ts` `CATEGORY_TO_PAPER` | sociology 9699 结构配置 |
| 单元顺序 | `unitMapping.ts` `UNIT_ORDER` + localStorage 覆盖 | sociology 9699 结构配置（syllabus 级） |
| 导入默认类别映射 | `excelImport.ts` 平行副本 | 收敛到 sociology manifest |
| 卷顺序 | `storage.ts` `PAPER_ORDER` | 收敛到 sociology 9699 `papers` |
| 范文/语境 | `public/cloze-data.json` | sociology 内容 |
| 真题切题资料 | `public/pastpaper-topics.json` | sociology 9699 内容 |
| 社会数据板 | `public/social-data.json` + `DataBoard` | sociology 内容 + 组件 |
| 组卷器模板 | `public/gt-templates.json` | sociology 9699 内容 |
| 词库生成脚本 | `scripts/generate-vocab.mjs`（指向外部 xlsx） | sociology 构建脚本 |

## 五、运行时接入

现有代码不直接读 `unitMapping.ts` 常量 / `public/*.json`，改经一层薄适配（关键，实现平滑过渡）：

```ts
// src/lib/subjectConfig.ts
// 传入 active subject(+syllabus)，返回该科的结构配置与内容 URL
export function getSubjectConfig(s: SubjectId) { ... registry 查表 ... }
export function assetUrl(s: SubjectId, key: string): string {
  // 过渡期返回原路径 /vocab-data.json；归位后返回 /data/{s}/{key}.json
}
```

加载策略与现状保持一致：**内置 JSON 只作离线兜底，正式以云端 `vocab_releases` 为准**（登录后同步覆盖），所以 manifest 里的内容文件是「导入/生成的源 + 离线兜底」，不承担权威。

## 六、平滑过渡路径（重点）

### 阶段 0 —— 现状
代码无 subject 概念；`PAPER_ORDER`/`UNIT_ORDER`/各 JSON 全局直读。一切照旧。

### 阶段 1 —— 加 subject 适配层，行为零变化
- 新增 `src/subjects/`：只放 `registry.ts` + `types.ts` + `sociology/manifest.ts`，**不移动任何现有文件**
- sociology manifest 的 syllabus 先只声明 9699，`source:'own'`；内容资源暂以「指向现有路径」方式登记（不物理搬移）
- 新增 `subjectConfig.ts` 薄层：现有读取点（`PAPER_ORDER`、`UNIT_ORDER`、各 fetch JSON）逐个改为经它取值；`DEFAULT_SUBJECT='sociology'`、默认 syllabus `9699`，**行为与阶段 0 完全一致**
- 交付标志：现有功能全绿、diff 只有「读取方式」变化

### 阶段 2 —— 0495 试点（社会学内部派生）
- 启用 `activeSyllabus`：由学生 → 班级（`classes.syllabus`）解析，注册/教师指定兜底
- `vocab_releases` 按 syllabus 过滤（cloud 三函数已留 syllabus 列）；本地缓存 key 加 syllabus 维度，避免两版互覆
- 0495 syllabus 加到 sociology manifest：`source:'derive', deriveFrom:'9699'` + 合并/排除规则
- **词条本体不改**：0495 视图 = 运行时投影（paper 合并 + nominal tag），词条 id 不变 → 9699↔0495 进度共享天然成立
- 交付标志：IGCSE 班只看到两卷、Paper 2 含原 2+3 内容、重叠词进度与 9699 互认

### 阶段 3 —— subject 进词条 id（趁单科做全量迁移）
- `stableId` 输入增加 subject（不含 syllabus）；复用现成 `migrateVocabStableIds` + `idMap` + `migrateAllProgressKeys` 基建做一次性迁移，学生端无感
- 说明：subject 前缀不影响 0495↔9699（同 subject 同 id），只消除跨科目碰撞；此时迁移成本最低，因为线上只有社会学一套数据
- 交付标志：跨科目词面重叠在代码层面不可能碰撞

### 阶段 4 —— 内容归位 + 开放注册
- 把 sociology 专属 JSON 脚本从 `public/`、`src/lib/` 归位到 `src/subjects/sociology/`（可脚本搬迁），`assetUrl` 切换为 `/data/{subject}/...`
- 加第二科（心理学）＝ 复制 `sociology/` 目录结构 → 填 manifest + 内容文件 → 注册自动完成，核心代码零改
- 若有科目专属 UI（如 DataBoard），登记为 manifest 里的可选扩展组件（`import.meta.glob` 动态加载），不影响主流程

## 七、边界情形与风险

1. **同 subject 内 syllabus 差异过大、无法用「合并/排除」派生**（如大纲全新改版）：退化为 `source:'own'` 的独立 syllabus。代价是与老大纲的同源词进度**不再自动共享**（id 输入不同）。草案默认接受；如确需共享再引入显式映射，属增量，不进入核心。
2. **quiz/作业表归属**：`quizzes` 现无 subject 列，阶段 2 起需补 subject 归属，学生凭 code 进入时按快照科目校验。
3. **词库本地缓存 key**（`VOCAB_KEY`）现不 scope：阶段 2 必须分 subject+syllabus，否则切科互覆（进度按 `user:{id}` scope + subject 前缀 id 已自动分科，不受影响）。
4. **打卡/错题/范文**：打卡跨科聚合（全局）；错题本按 subject 前缀 id 自然分科；范文/语境属科目内容。

## 八、待拍板点

1. 科目范围：先只落地 sociology + psychology 两科，还是预置三科？注册制下二者代码成本相同，仅内容制作不同。
2. 教师端多科：现状单科教师是多数，是否阶段 4 才做教师端科目切换器？（建议：默认不做，检测到多科再显示）
3. 0495 词库是「视图投影（词条本体不变）」还是「独立 release（词条复制、改 paper 归属）」——本草案推荐前者，否则与 9699 的进度共享断裂（id 含 paper）。
