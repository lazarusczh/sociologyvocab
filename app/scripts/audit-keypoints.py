"""定义题要素标注体检（纯规则，不调模型、不耗额度）

背景（2026-09-22）：`Institutional racism` 上两个不同模型都判错，核对发现是**数据侧**问题：
  · 要素1 的英文 `en` 在 "due to" 处被截断，后半句丢失；
  · 要素2 其实含定义主干含义，却被标成 `example`（判分时要求"举出举例项"），
    而 full 样本用的就是参考原文、不含该举例 → **该术语结构性地永远判不出 correct**。
担心这类问题不止一例，故做一次批量体检。

检测项：
  A. `en` 疑似被截断（以介词/连词/系动词等虚词结尾）
  B. `en` 为空（无英文表述 → 判分退回中文，跨语言判定条件变差）
  C. `kind=example` 但读起来像定义主干（en 很长 / 含定义句式 / 中文含定义性措辞）
  D. 纯举例型术语（一个 required 都没有）—— 判分口径与前缀型不同，需人工确认是否合理
  E. 举例项过多的术语（≥5 个）

用法：python scripts/audit-keypoints.py [--out 报告.md]
"""
import argparse
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "definition-keypoints.json"

# 以这些词结尾 → 句子明显没写完
TAIL_STOP = {
    "a", "an", "the", "of", "to", "in", "on", "at", "by", "with", "for", "from", "as", "into",
    "about", "between", "than", "and", "or", "but", "that", "which", "who", "whose", "where",
    "when", "because", "due", "their", "its", "his", "her", "our", "your", "this", "these",
    "those", "is", "are", "was", "were", "be", "has", "have", "had", "such", "not", "no",
}
# 像"定义主干"的句式
DEF_PAT = re.compile(
    r"\b(is a|is an|is the|refers to|is defined|means|consists of|that has become|that are|that is|"
    r"whereby|in which)\b", re.I)
ZH_DEF_PAT = re.compile(r"已成为|常态化|定义|本质|指的是|表示|是一种|属于")
# 把数字也算作"词"，否则 "…of 2010-2012" / "…in 2000" 这类会被误判为「以虚词结尾」
WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'\-]*")


def audit(rows):
    issues = {"truncated": [], "no_en": [], "example_like_required": [],
              "no_required": [], "many_examples": []}
    total_kp = 0
    ex_counts = []

    for r in rows:
        term = r.get("term", "?")
        kps = r.get("keypoints", []) or []
        total_kp += len(kps)
        req = [k for k in kps if (k.get("kind") or "required") != "example"]
        ex = [k for k in kps if (k.get("kind") or "required") == "example"]
        ex_counts.append(len(ex))

        for i, k in enumerate(kps, 1):
            en = (k.get("en") or "").strip()
            zh = (k.get("text") or "").strip()
            kind = k.get("kind") or "required"
            if not en or not re.search(r"[A-Za-z]", en):
                # en 为空、或 en 里根本没有英文字母（实际写的是中文）→ 都算"无英文表述"
                issues["no_en"].append((term, i, kind, zh or en))
                continue
            words = WORD_RE.findall(re.sub(r"[.,;:]+$", "", en))
            if words and words[-1].lower() in TAIL_STOP:
                issues["truncated"].append((term, i, kind, en, words[-1]))
            if kind == "example":
                why = []
                if len(en) > 90:
                    why.append(f"en 很长({len(en)} 字符)")
                if DEF_PAT.search(en):
                    why.append("en 含定义句式")
                if ZH_DEF_PAT.search(zh):
                    why.append("zh 含定义性措辞")
                if why:
                    issues["example_like_required"].append((term, i, "；".join(why), en[:90], zh[:50]))

        if kps and not req:
            issues["no_required"].append((term, len(kps)))
        if len(ex) >= 5:
            issues["many_examples"].append((term, len(ex)))

    return issues, total_kp, ex_counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    rows = json.loads(SRC.read_text(encoding="utf-8"))
    issues, total_kp, ex_counts = audit(rows)

    L = []
    L.append("# 定义题要素标注体检报告")
    L.append("")
    L.append(f"- 数据源：`app/data/definition-keypoints.json`")
    L.append(f"- 术语 **{len(rows)}** 条，要素 **{total_kp}** 个")
    L.append("")
    L.append("| 检测项 | 命中 |")
    L.append("|---|---|")
    L.append(f"| A. `en` 疑似截断 | **{len(issues['truncated'])}** |")
    L.append(f"| B. `en` 为空（无英文表述） | **{len(issues['no_en'])}** |")
    L.append(f"| C. `example` 但像定义主干 | **{len(issues['example_like_required'])}** |")
    L.append(f"| D. 纯举例型（无 required） | **{len(issues['no_required'])}** |")
    L.append(f"| E. 举例项 ≥5 个 | **{len(issues['many_examples'])}** |")
    L.append("")

    L.append("## A. `en` 疑似截断（以虚词结尾）")
    L.append("")
    L.append("> 最危险的一类：判分要求逐个要素按**英文含义**判断，英文残缺会让模型只能靠猜。")
    L.append("")
    if issues["truncated"]:
        L.append("| 术语 | 第几个要素 | kind | 结尾词 | en |")
        L.append("|---|---|---|---|---|")
        for term, i, kind, en, tail in issues["truncated"]:
            L.append(f"| {term} | {i} | {kind} | `{tail}` | {en[:100]} |")
    else:
        L.append("（无）")
    L.append("")

    L.append("## B. `en` 为空（无英文表述）")
    L.append("")
    if issues["no_en"]:
        L.append("| 术语 | 第几个要素 | kind | 中文 |")
        L.append("|---|---|---|---|")
        for term, i, kind, zh in issues["no_en"]:
            L.append(f"| {term} | {i} | {kind} | {zh[:60]} |")
    else:
        L.append("（无）")
    L.append("")

    L.append("## C. 标为 `example` 但像定义主干（疑似该改 `required`）")
    L.append("")
    L.append("> 这类若判错，表现为「该术语永远判不出 correct」（举例项在参考原文里并不存在）。")
    L.append("")
    if issues["example_like_required"]:
        L.append("| 术语 | 第几个要素 | 可疑原因 | en | zh |")
        L.append("|---|---|---|---|---|")
        for term, i, why, en, zh in issues["example_like_required"]:
            L.append(f"| {term} | {i} | {why} | {en} | {zh} |")
    else:
        L.append("（无）")
    L.append("")

    L.append("## D. 纯举例型（一个 `required` 都没有）")
    L.append("")
    if issues["no_required"]:
        L.append("| 术语 | 要素数 |")
        L.append("|---|---|")
        for term, n in issues["no_required"]:
            L.append(f"| {term} | {n} |")
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

    text = "\n".join(L)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print("报告写入：", args.out)
    print("\n".join(L[:22]))
    print(f"\n（完整报告共 {len(L)} 行）")


if __name__ == "__main__":
    main()
