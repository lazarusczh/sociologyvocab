# 云端 v100 只读实测：contrast 分类 + 盟友候选（2026-10-26 复盘）

> 只读诊断，未改动任何代码/数据结构/关系数据。词条 902 条，发布 2026-10-21T03:54:40.6952+00:00

## 一、contrast 现状与两种规则对比

- contrast 边 **48** 条（v84 时为 49 条）；层级边 765；概念组 640；环 0

| 规则 | oppose | rival |
|---|---|---|
| 旧规则：裸 depth 差 ≥1 → oppose | 28 | 20 |
| 新规则：祖裔可达（或直接层级边）→ oppose | 1 | 47 |

**换规则后变化**：27 条从 oppose 改判为 rival（旧规则的误判），0 条从 rival 改判为 oppose。

| 新规则下 oppose | 对应 rival 候选 | 依据 | depth A/B |
|---|---|---|---|
| Functionalism（功能主义） | Family diversity（家庭多样化） | 祖裔可达 | 2 / 7 |

## 二、5.2 盟友候选（一阶共同对手 A⊥B、C⊥B）

- 生成的盟友对子 **29** 组
  - 其中 **24** 组目前没有任何关系 → 真正的「编辑助手建议」价值
  - 2 组已经是显式 peer → 属于冗余确认
  - 3 组同时也标了 contrast → **矛盾数据**（既是盟友又是敌人），需教师复核
- 两端 degree 都为 1 的 contrast 边：0 条（孤立对立，几乎不会产生盟友）

### 共同对手扇出 Top 10（会贡献多少盟友对子）

| 共同对手 B | 反对它的节点数 | 可生成对子数 n(n-1)/2 |
|---|---|---|
| Modernisation theory（现代化） | 5 | 10 |
| Postmodernism（后现代主义） | 3 | 3 |
| New Right（新右翼） | 3 | 3 |
| Non-Governmental Organisation（非政府组织） | 3 | 3 |
| Conformity（服从） | 2 | 1 |
| Deviance（叛逆） | 2 | 1 |
| Functionalism（功能主义） | 2 | 1 |
| Marxism（马克思主义） | 2 | 1 |
| Family diversity（家庭多样化） | 2 | 1 |
| Interactionism（互动论） | 2 | 1 |

### 全部盟友对子（按共同对手分组，最多列 60 组）

| 共同对手 | 盟友 A | 盟友 B | 现状 |
|---|---|---|---|
| Value-free（价值中立） | Bias（偏见） | Subjective（主观的） | 无关系 |
| Subjective（主观的） | Objective（客观的） | Value-free（价值中立） | 无关系 |
| Structuralism（结构主义） | Interactionism（互动论） | Postmodernism（后现代主义） | ⚠ 同时互为对立 |
| Postmodernism（后现代主义） | Interactionism（互动论） | Structuralism（结构主义） | ⚠ 同时互为对立 |
| Postmodernism（后现代主义） | Interactionism（互动论） | Late modernism（晚期现代主义） | 无关系 |
| Postmodernism（后现代主义） | Late modernism（晚期现代主义） | Structuralism（结构主义） | 无关系 |
| Patriarchy（父权社会） | Feminism（女性主义） | Matriarchy（女权社会） | 无关系 |
| Objective（客观的） | Paradigm（范式） | Subjective（主观的） | 无关系 |
| Non-Governmental Organisation（非政府组织） | European Union（欧洲联盟） | Interpol（国际刑警组织） | 无关系 |
| Non-Governmental Organisation（非政府组织） | European Union（欧洲联盟） | United Nations（联合国） | 无关系 |
| Non-Governmental Organisation（非政府组织） | Interpol（国际刑警组织） | United Nations（联合国） | 无关系 |
| New Right（新右翼） | Marxism（马克思主义） | Welfare state（福利国家/福利体系） | 无关系 |
| New Right（新右翼） | Family diversity（家庭多样化） | Welfare state（福利国家/福利体系） | 无关系 |
| Modernisation theory（现代化） | Crisis of modernism（现代主义的危机） | Dependency Theory（依赖理论） | 无关系 |
| Modernisation theory（现代化） | Crisis of modernism（现代主义的危机） | Eclecticism（折衷主义） | 无关系 |
| Modernisation theory（现代化） | Crisis of modernism（现代主义的危机） | World System（世界体系） | 无关系 |
| Modernisation theory（现代化） | Crisis of modernism（现代主义的危机） | Post-developmental perspective（后发展主义） | 无关系 |
| Modernisation theory（现代化） | Dependency Theory（依赖理论） | Eclecticism（折衷主义） | 无关系 |
| Modernisation theory（现代化） | Dependency Theory（依赖理论） | World System（世界体系） | 已是 peer |
| Modernisation theory（现代化） | Dependency Theory（依赖理论） | Post-developmental perspective（后发展主义） | 无关系 |
| Modernisation theory（现代化） | Eclecticism（折衷主义） | World System（世界体系） | 无关系 |
| Modernisation theory（现代化） | Eclecticism（折衷主义） | Post-developmental perspective（后发展主义） | 无关系 |
| Modernisation theory（现代化） | Post-developmental perspective（后发展主义） | World System（世界体系） | 无关系 |
| Marxism（马克思主义） | Functionalism（功能主义） | New Right（新右翼） | 已是 peer |
| Interactionism（互动论） | Postmodernism（后现代主义） | Structuralism（结构主义） | ⚠ 同时互为对立 |
| Functionalism（功能主义） | Family diversity（家庭多样化） | Marxism（马克思主义） | 无关系 |
| Feminism（女性主义） | Misogynism（厌女主义） | Patriarchy（父权社会） | 无关系 |
| Deviance（叛逆） | Conformity（服从） | Meta-narrative（元叙事） | 无关系 |
| Conformity（服从） | Deviance（叛逆） | Non-conformity（不服从） | 无关系 |

## 三、结论（供决策）

1. **祖裔可达性规则把 oppose 从旧轮的 28 压到 1**，与「真正的跨级反对是少数」的语义直觉一致；如按此规则，误判大幅减少。
2. **前提否定型仍无法自动判别**（结构上不会表现为祖裔关系），仍需教师手标。
3. **盟友候选规模**：24 组无关系的候选，适合做编辑助手提示；3 组矛盾数据值得先行复核。