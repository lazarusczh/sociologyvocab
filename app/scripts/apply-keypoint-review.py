"""应用教师 2026-09-22 的要素裁定（方案 A：改 kind；并修正 3 处英文/中文切分）

教师裁定要点（原话摘要）：
  · 普遍的根因：很多词条是 `A type of X that (elaborated)` 的**展开阐述**结构，
    整句都是定义，却被切成若干 `example` → 主干不受约束 → 判分过松。
  · 因此把「必要的」内容一律标为 `required`；只有真正的并列举例（举几项即可）保持 `example`。
  · `Existential crisis` 要素2 经教师复核后**保持 example**（它是对 push factor 的解释）。
  · `Personal identity` 要素2、3 保持 example —— 因为 2 个 example 时判分只要求举 1 项，
    正合教师"答其一即可"的要求。
  · 同时修正 3 处切分错误：Social support network / Digital narcissism / Emotional labour
    （原文的 because / but 从句被并进了前一条，导致后一条英文为空；Emotional labour 还中英错位）。

改动**不增删要素**，只改 kind / en / text —— 因此判分时的 coverage 数组长度不变，向后兼容。
用法：python scripts/apply-keypoint-review.py [--write]
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "definition-keypoints.json"

# 术语 → 裁定
#   kinds: {要素序号(1-based): 'required'|'example'}，ALL 表示全部
#   en / text: {要素序号: 修正后的文本}
REVIEW = {
    "Existential crisis": {"kinds": {1: "required", 3: "required"}},   # 2 保持 example
    "Social support network": {
        "kinds": {1: "required", 2: "required", 3: "required"},
        "en": {2: "when there is a supportive network of family or compatriots, people are more likely to migrate",
               3: "because the difficulty and stress of migration can be reduced"},
    },
    "Digital narcissism": {
        "kinds": {1: "required", 2: "required", 3: "required"},
        "en": {2: "the users of digital social media do not use it in a way to learn about new things",
               3: "but to use it to share the trivials of their daily life"},
    },
    "Emotional labour": {
        "kinds": {1: "required", 2: "required", 3: "required"},
        "en": {1: "The invisible housework labour that women are often required to do",
               2: "to comfort other family members",
               3: "to provide company to them"},
        "text": {2: "为了安慰其他家庭成员", 3: "并为家庭成员提供陪伴"},
    },
    "Culture of failure": {"kinds": {"ALL": "required"}},
    "Compression": {"kinds": {"ALL": "required"}},
    "Caring": {"kinds": {"ALL": "required"}},
    "Affirmative Action": {"kinds": {"ALL": "required"}},
    "Borderline cases": {"kinds": {"ALL": "required"}},
    "Contextual admission": {"kinds": {"ALL": "required"}},
    "Judicial system": {"kinds": {"ALL": "required"}},
    "Counterfeit": {"kinds": {"ALL": "required"}},
    "Money laundering": {"kinds": {"ALL": "required"}},
    "Frequency": {"kinds": {1: "required"}},
    "Personal identity": {"kinds": {1: "required"}},
    "Horizontal integration": {"kinds": {1: "required"}},
    "Loss of function": {"kinds": {1: "required"}},
    "Obesity": {"kinds": {1: "required", 2: "required"}},
    "Social Learning Theory": {"kinds": {1: "required", 2: "required"}},
    "Entrepreneur": {"kinds": {1: "required", 4: "required"}},
    # 教师明确"不动"的： Personal relationship / Ethnic / Cultural diversity
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    rows = json.loads(SRC.read_text(encoding="utf-8"))
    index = {(r.get("term") or "").strip(): r for r in rows}

    log = []
    for term, spec in REVIEW.items():
        r = index.get(term)
        if not r:
            log.append(f"!! 未找到术语：{term}")
            continue
        kps = r.get("keypoints") or []
        kinds = spec.get("kinds") or {}
        for i, k in enumerate(kps, 1):
            new = kinds.get("ALL") or kinds.get(i)
            old_kind = k.get("kind") or "required"
            if new and old_kind != new:
                log.append(f"{term} 要素{i}: kind {old_kind} → {new}")
                k["kind"] = new
        for i, text in (spec.get("en") or {}).items():
            if i <= len(kps):
                old = kps[i - 1].get("en")
                if old != text:
                    log.append(f"{term} 要素{i}: en 修正")
                    kps[i - 1]["en"] = text
        for i, text in (spec.get("text") or {}).items():
            if i <= len(kps):
                old = kps[i - 1].get("text")
                if old != text:
                    log.append(f"{term} 要素{i}: zh 修正（{old} → {text}）")
                    kps[i - 1]["text"] = text

    # 复核各术语改动后的 kind 分布
    print("== 改动明细 ==")
    for line in log:
        print("  ·", line)
    print(f"\n共 {len(log)} 处改动")

    print("\n== 改动后仍是「纯举例型」的术语（应只剩教师认可的）==")
    for r in rows:
        kps = r.get("keypoints") or []
        if kps and not [k for k in kps if (k.get("kind") or "required") != "example"]:
            print("  ·", r["term"])

    if args.write:
        SRC.write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"\n已写回：{SRC}")
    else:
        print("\n（未写回；加 --write 生效）")


if __name__ == "__main__":
    main()
