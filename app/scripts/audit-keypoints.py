"""定义题要素标注体检（纯规则，不调模型、不耗额度）

背景（2026-09-22）：`Institutional racism` 上两个不同模型都判错，核对发现是**数据侧**问题：
  · 要素1 的英文 `en` 与原文不符；
  · 要素2 其实是定义主干，却被标成 `example`（判分要求"举出举例项"），
    而 full 样本用的就是参考原文、不含该举例 → **该术语结构性地永远判不出 correct**。

⚠️ 本脚本的教训（写在前面，避免误读）：
  第一版靠"`en` 以虚词结尾"判截断，结果**全是误报** —— 因为我读的是报告里 `en[:100]` 的
  **显示截断**，把显示问题当成了数据问题。现在改为**与 `source_defs`（权威英文原文）交叉验证**：
  只要 `en` 能对上原文，就不算截断。

检测项：
  A. `en` 疑似截断 —— **且无法在 source_defs 里找到对应**（已排除"来自原文但切分点不理想"的情形）
  B. `en` 无英文表述（为空，或 en 里其实是中文）→ 判分退回中文，跨语言判定条件变差
  C. `kind=example` 但读起来像定义主干（en 很长 / 含定义句式 / 中文含定义性措辞）
  D. 纯举例型术语（一个 required 都没有）—— 判分只要求"举够例子"，有**过松**风险
  E. 举例项 ≥5 个

用法：python scripts/audit-keypoints.py [--out 报告.md]
"""
import argparse
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "definition-keypoints.json"

TAIL_STOP = {
    "a", "an", "the", "of", "to", "in", "on", "at", "by", "with", "for", "from", "as", "into",
    "about", "between", "than", "and", "or", "but", "that", "which", "who", "whose", "where",
    "when", "because", "due", "their", "its", "his", "her", "our", "your", "this", "these",
    "those", "is", "are", "was", "were", "be", "has", "have", "had", "such", "not", "no",
}
DEF_PAT = re.compile(
    r"\b(is a|is an|is the|refers to|is defined|means|consists of|that has become|that are|that is|"
    r"whereby|in which)\b", re.I)
ZH_DEF_PAT = re.compile(r"已成为|常态化|定义|本质|指的是|是一种|属于")
# 归类/定义句式 —— 出现在 example 项里往往意味着它其实该是 required。
# 刻意**不含**「an example of…」（那确实是举例，标 example 是对的）。
WEAK_HEAD = re.compile(
    r"^\s*(a type of|a kind of|a part of|an aspect of|a form of|a sort of|a category of|a branch of|"
    r"is a type of|is a form of)\b", re.I)
# 数字也算"词"：否则 "…of 2010-2012" 会被误判为以虚词结尾
WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'\-]*")
NORM_RE = re.compile(r"[^a-z0-9]+")


def norm(s: str) -> str:
    return NORM_RE.sub(" ", (s or "").lower()).strip()


def matches_source(en: str, source_defs: dict) -> bool:
    """en 是否出现在某个来源原文里（归一化后子串匹配）—— 是则说明它确实取自原文，不是截断"""
    e = norm(en)
    if not e:
        return False
    for d in (source_defs or {}).values():
        if e in norm(d):
            return True
    return False


def audit(rows):
    issues = {"truncated": [], "no_en": [], "example_like_required": [],
              "no_required": [], "many_examples": []}
    total_kp = 0
    ex_counts = []
    detail = {}          # 术语 → 全部要素（供人工核对 C/D）

    for r in rows:
        term = r.get("term", "?")
        kps = r.get("keypoints", []) or []
        sdefs = r.get("source_defs") or {}
        total_kp += len(kps)
        req = [k for k in kps if (k.get("kind") or "required") != "example"]
        ex = [k for k in kps if (k.get("kind") or "required") == "example"]
        ex_counts.append(len(ex))

        for i, k in enumerate(kps, 1):
            en = (k.get("en") or "").strip()
            zh = (k.get("text") or "").strip()
            kind = k.get("kind") or "required"
            if not en or not re.search(r"[A-Za-z]", en):
                issues["no_en"].append((term, i, kind, zh or en))
                continue
            words = WORD_RE.findall(re.sub(r"[.,;:]+$", "", en))
            if words and words[-1].lower() in TAIL_STOP and not matches_source(en, sdefs):
                issues["truncated"].append((term, i, kind, en, words[-1]))
            if kind == "example":
                why = []
                # 最强信号：以「A type of / A part of / A form of …」这类**归类/定义**句式开头
                # —— 注意排除「an example of …」（那确实是举例，标 example 正确）
                if WEAK_HEAD.search(en):
                    why.append("★en 以「A type/part/form of…」开头（归类句式）")
                if len(en) > 90:
                    why.append(f"en 很长({len(en)} 字符)")
                if DEF_PAT.search(en):
                    why.append("en 含定义句式")
                if ZH_DEF_PAT.search(zh):
                    why.append("zh 含定义性措辞")
                if why:
                    issues["example_like_required"].append((term, i, "；".join(why), en, zh))

        if kps and not req:
            issues["no_required"].append((term, len(kps)))
            detail[term] = kps
        if len(ex) >= 5:
            issues["many_examples"].append((term, len(ex)))
        # C 类也记录全部要素，便于人工判断
        for term_, i, _, _, _ in issues["example_like_required"]:
            if term_ == term:
                detail[term] = kps
                break

    return issues, total_kp, ex_counts, detail


def render(issues, rows, total_kp, ex_counts, detail):
    L = []
    L.append("# 定义题要素标注体检报告")
    L.append("")
    L.append("- 数据源：`app/data/definition-keypoints.json`")
    L.append(f"- 术语 **{len(rows)}** 条，要素 **{total_kp}** 个")
    L.append(f"- 生成脚本：`app/scripts/audit-keypoints.py`")
    L.append("")
    L.append("| 检测项 | 命中 |")
    L.append("|---|---|")
    L.append(f"| A. `en` 疑似截断（且对不上原文） | **{len(issues['truncated'])}** |")
    L.append(f"| B. `en` 无英文表述 | **{len(issues['no_en'])}** |")
    L.append(f"| C. `example` 但像定义主干 | **{len(issues['example_like_required'])}** |")
    L.append(f"| D. 纯举例型（无 required） | **{len(issues['no_required'])}** |")
    L.append(f"| E. 举例项 ≥5 个 | **{len(issues['many_examples'])}** |")
    L.append("")

    L.append("## A. `en` 疑似截断（已与 `source_defs` 交叉验证）")
    L.append("")
    L.append("> 判据：`en` 以虚词结尾**且**在权威原文里找不到对应 → 才列为可疑。")
    L.append("")
    if issues["truncated"]:
        L.append("| 术语 | 第几个要素 | kind | 结尾词 | en |")
        L.append("|---|---|---|---|---|")
        for term, i, kind, en, tail in issues["truncated"]:
            L.append(f"| {term} | {i} | {kind} | `{tail}` | {en} |")
    else:
        L.append("**（无）** —— 说明此前的 9 条全部属于「取自原文但切分点不理想」或自然句尾，不是数据损坏。")
    L.append("")

    L.append("## B. `en` 无英文表述")
    L.append("")
    L.append("> 规律提示：多数出现在**第 3 个及以后的要素**，疑似英文对齐脚本只处理了前两个要素。")
    L.append("")
    if issues["no_en"]:
        L.append("| 术语 | 第几个要素 | kind | 中文/内容 |")
        L.append("|---|---|---|---|")
        for term, i, kind, zh in issues["no_en"]:
            L.append(f"| {term} | {i} | {kind} | {zh[:70]} |")
    else:
        L.append("（无）")
    L.append("")

    L.append("## C. 标为 `example` 但像定义主干（附该术语全部要素，便于人工判断）")
    L.append("")
    L.append("> 判据是启发式，**会有误报**（例：`Brexit` 的 `It is an example of…` 标 `example` 是对的）。")
    L.append("> 请对照下表的「全部要素」判断：若去掉该要素、术语定义就不成立，则应改 `required`。")
    L.append("")
    if issues["example_like_required"]:
        # 带 ★ 的（归类句式）置信度最高，排在最前面
        for term, i, why, en, zh in sorted(
                issues["example_like_required"], key=lambda x: (0 if "★" in x[2] else 1)):
            L.append(f"### {term} —— 第 {i} 个要素可疑")
            L.append("")
            L.append(f"- 可疑原因：{why}")
            L.append("")
            L.append("| # | kind | en | zh |")
            L.append("|---|---|---|---|")
            for j, k in enumerate(detail.get(term, []), 1):
                kind = k.get("kind") or "required"
                L.append(f"| {j} | {kind} | {(k.get('en') or '—')[:110]} | {(k.get('text') or '—')[:70]} |")
            L.append("")
    else:
        L.append("（无）")
    L.append("")

    L.append("## D. 纯举例型术语（一个 `required` 都没有）")
    L.append("")
    L.append("> ⚠️ 判分影响：`reqIdx` 为空 → 主干不设约束 → **只要求举够 1~2 个例子就判 correct**，有**过松**风险。")
    L.append("> 请判断这些术语是否真的属于「并列举例型」；若不是，应把定义主干补标为 `required`。")
    L.append("")
    if issues["no_required"]:
        for term, n in issues["no_required"]:
            L.append(f"### {term}（{n} 个要素，全部为 example）")
            L.append("")
            L.append("| # | kind | en | zh |")
            L.append("|---|---|---|---|")
            for j, k in enumerate(detail.get(term, []), 1):
                kind = k.get("kind") or "required"
                L.append(f"| {j} | {kind} | {(k.get('en') or '—')[:110]} | {(k.get('text') or '—')[:70]} |")
            L.append("")
    else:
        L.append("（无）")
    L.append("")

    L.append("## E. 举例项 ≥5 个")
    L.append("")
    if issues["many_examples"]:
        L.append("| 术语 | 举例项数 |")
        L.append("|---|---|")
        for term, n in issues["many_examples"]:
            L.append(f"| {term} | {n} |")
    else:
        L.append("（无）")
    L.append("")

    dist = Counter(ex_counts)
    L.append("## 附：每个术语的举例项数量分布")
    L.append("")
    L.append("| 举例项数 | 术语数 |")
    L.append("|---|---|")
    for n in sorted(dist):
        L.append(f"| {n} | {dist[n]} |")
    L.append("")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    rows = json.loads(SRC.read_text(encoding="utf-8"))
    issues, total_kp, ex_counts, detail = audit(rows)
    text = render(issues, rows, total_kp, ex_counts, detail)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print("报告写入：", args.out)
    print("\n".join(text.split("\n")[:16]))
    print(f"\n（完整报告 {len(text.splitlines())} 行）")


if __name__ == "__main__":
    main()
