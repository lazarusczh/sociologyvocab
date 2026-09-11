# 知识库（教材 AI 问答）方案

> 状态：已实施并线上运行（2026-09-11）
> 入口：主站 `/skill/`（教材知识库子站）→ 「AI 问答」；后端 `/skill-api/*`（Cloudflare Worker）
> 相关：`组卷器方案.md`（题库）、主站 `vocab_releases`（词库，仅作中英映射的补充来源）

## 一、定位

把两本教材（Haralambos / Livesey & Blundell）+ 历年真题评分视角挂成 AI 问答语料，**与主站人工标注词库互补**：词库负责"教学固定说法"，AI 负责"学生自由提问"。

## 二、语料分层（四张云端表，均 RLS 仅登录可读）

| 表 | 内容 | 角色 |
|---|---|---|
| `skill_content` | 蒸馏教材章（9 + 8 章）+ 真题评分视角（27 考点章），整份 JSON 按版本号 | **结构/导航层**：考点骨架、术语、答题模式 |
| `skill_pages` | 教材 OCR 原文按页存（Haralambos 681 页 + Livesey 334 页） | **细节层**：按需取页，保住研究案例等正文细节 |
| `skill_page_index` | 每本一行：页级关键词 + `units`(Unit→起始页) + `chapters`(章→起始页) + `terms`(中英术语桥) | **常驻索引层**：把问题定位到页码 |
| `skill_scaffolds` | 按章抽取的 `Mental Models / Anti-patterns / Key Takeaways`（17 章） | **教学口径层**：作答时注入 system |

## 三、检索链路（一次提问的完整路径）

1. 蒸馏层检索（`retrieval.ts` 的 `retrieve()`）→ 命中章节段落 + 术语表（跨全部书目）
2. 中文提问先查**离线术语桥**（`localTerms()`，来自 glossary 的中文译名 → 英文术语）；命中不足 3 个才调 `/skill-api/terms`（Workers AI 8B）做翻译兜底
3. 页级索引打分（`retrievePages()`）：关键词精确 +3 / 词形宽松匹配 +1~2 / 章·节标签 +2；**Unit 标题命中**直接给该考点起始页高分
4. `expandPages()` 命中页 **±1**，`buildPageContext()` 把同章连续页合并成块（出处给页码范围，如 `p.322-327`）
5. 命中章 → `buildScaffoldText()` 注入 system（教师口径：答题结构 + 常见失分点）
6. 组装 messages → 模型链路由

**预算**：页材料 12000 字符 / 单块 4500 / 每本最多 3 个命中页（±1 后约 9 页）；材料按分数排序，超预算截尾。

**模型链**：评估/对比类 → ModelScope Qwen3-235B-Thinking；日常 → Qwen3 快速档；降级 → OpenRouter nemotron(:free)；兜底 → Workers AI llama-3.1-8B。
**兜底降配**（`shrinkForLlama()`）：落到 8B 时材料按块裁剪到 8000 字符，**优先保留原文页块**（细节最具体），并追加"要点式简答"指令覆盖"展开 300–500 字"要求。

## 四、数据流水线（教材换版 / 新增书时重跑）

```
python scripts/skill-pdf-pages.py --book haralambos --out <dir>
python scripts/skill-pdf-pages.py --book livesey    --out <dir>
node   scripts/skill-pages-import.mjs --dir tb1=<dir> --dir tb2=<dir> --out <sql>
psql "<云端连接串>" -w -v ON_ERROR_STOP=1 -f <sql>
python scripts/skill-scaffold-extract.py --out <sql>   # 章答题脚手架（蒸馏章内容变化时重跑）
psql ... -f <sql>
```
- 蒸馏层（`skill_content`）：`scripts/skill-ms-pipeline.mjs`（真题切题 → 主题素材卡）+ `scripts/skill-md-json.mjs`（md → JSON），上传走 `skill-import-sql.mjs`
- 教材 PDF 源（含文本层 OCR 版）在 `OneDrive/.../SESCIE/`，脚本内部用 glob 匹配（避开中文路径传参问题）

## 五、覆盖体检（改动后必跑）

```
node scripts/skill-coverage-check.mjs --dir tb1=<dir> --dir tb2=<dir> [--full]
```
三类指标（内部会先打包真实的 `retrieval.ts`，保证测的就是线上打分）：
- **页召回**：抽样页 → 用该页索引关键词查询 → 能否召回该页（当前 96.7% / 100%）
- **Unit 指针**：Unit 标题实词 → 能否召回该 Unit 起始页（Haralambos 87/87 = 100%）
- **术语桥**：中文译名 → 英文术语 → 能否召回到页（`--full` 全量：205/205、231/233）

未命中清单就是待补项（补索引关键词 / 调权重 / 补蒸馏覆盖）。

## 六、踩坑与结论

1. **蒸馏粒度是被牺牲的**：book-to-skill 默认按"章"蒸馏，681 页 9 章 → 每章 5–7KB，研究案例（如 Ward 2015 的 Boiz/Geeks）被压成术语清单 → AI 答"知识库未覆盖"。**正解是引原文**（页级检索），而非把蒸馏调细。
2. **索引词形问题**：术语表 `sociobiology` ↔ 正文 `sociobiologists`；检索端需**双向词形匹配**（长词允许尾部 2 字母差异，短词要求完全前缀），且只有 ≥8 字符的长词才放宽，否则 `social` 会误配 `sociobiology`。
3. **句首词污染**：`This / They / How` 这类大写句首词曾被当成关键词 → 已按停用词过滤；低频概念（`asceticism`、`attrition`）则用术语表反向匹配页文本补进索引。
4. **每页关键词有上限**（70 条）：术语必须在截断前优先保留，否则会被按字母序挤掉（`institutional racism` 曾如此丢失）。
5. **纯中文提问打不中英文索引** → 离线术语桥为主 + 模型翻译兜底（见链路第 2 步）。
6. **8B 兜底档**：材料越多越容易跑偏；除了降配裁剪，还要靠"按章注入答题脚手架"给它结构模板。

## 七、问答区渲染（`skill-site/src/md.ts`）

模型输出常有"列表项之间夹空行"和"项内缩进子项"，按 `\n{2,}` 粗暴切块会让每个列表项变成独立的 `<ol>` → **每项都显示"1."**。现在：按行扫描合并列表（跨空行、缩进子项归入父项）、整行加粗识别为小标题、有序列表用**自绘编号**（源编号连续就沿用，不连续就自增重排）。

## 八、待办 / 可选增强

- [ ] 术语共现簇扩展：用蒸馏章 `Key Concepts` 行的术语群做查询扩展（需配分数阈值，否则材料变多反而拖累 8B）
- [ ] 黄金回归集：从 101 个 Unit 自动生成固定用例，改动前必跑（现在体检是随机抽样）
- [ ] 主站 `vocab_releases` 的中英对照并入术语桥（当前只用了蒸馏 glossary）
- [ ] 命中页相关性精排（现在只有关键词加权，可加页内位置/密度）
