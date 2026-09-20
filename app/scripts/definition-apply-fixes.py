"""定义题踩分点修正：① 补回 11 条「丢句型」的主干；② 给全部条目补 source_defs（各来源英文原文）。

背景（见 `定义题-总括式主干现状与改动清单.md`）：
  归纳链路是「英文原文 → 中文摘要 → 中文 keypoints」，两次压缩会把 `A X that <限定>` 结构的
  定语从句丢掉，并把从句内容错标成 example。典型：Diabetes 的词库原文是
  "A disease **that is increasingly seen on children**"，中文主干却只剩「糖尿病是一种疾病」。

本脚本做两件事（**只动 definition-keypoints.json，不碰词库定义**）：

① FIXES —— 手工修正 11 条主干：**只把词库英文原文里被丢掉的部分补回**，
   不得用外部知识替换来源表述；已并入主干的 example 项同步删除（避免重复计分）。
   ⚠️ 这 11 条是人工修正：**重跑 skill-keypoints.py / definition-tag-kinds.py 会覆盖它们**，
      重跑归纳后需再次执行本脚本。

② source_defs —— 从词库（云端 vocab_releases 最新版）与教材/0495 keyterms 取英文原文，
   存进每条目的 `source_defs`，供判分时作为语义参照（同语言比对，避免中文要素丢信息）。

用法：
  python scripts/definition-apply-fixes.py                 # dry-run
  python scripts/definition-apply-fixes.py --write         # 写回
"""
import argparse
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POOL = ROOT / "data/definition-keypoints.json"
KEYTERMS = ROOT / "data/ms-skill/keyterms"

QUOTES = "‘’“”'\"`´"


def norm(s: str) -> str:
    s = (s or "").strip().lower()
    s = s.translate(str.maketrans({c: "" for c in QUOTES}))
    s = re.sub(r"\s*/\s*", " / ", s)
    return re.sub(r"[\s\u00a0]+", " ", s)


# ---- ① 11 条主干修正（改写原则：只用词库英文原文里有的内容）----
FIXES = {
    "diabetes": {
        "required": "一种在儿童中日益常见的疾病",
        "drop_examples": ["糖尿病在儿童中越来越常见"],
    },
    "education": {
        "required": "由学校提供的正规教育，包括在校学到的知识与经历",
        "drop_examples": ["在学校学到的知识", "在学校遇到的经历"],
    },
    "equality": {
        "required": "一种以政治信仰、宗教信仰、投票权及公民生活各领域的平等权为核心的人权观",
        "drop_examples": ["关注政治信仰上的平等权", "关注宗教信仰上的平等权",
                          "关注投票权（选举权）上的平等权", "关注公民生活其他所有方面的平等权"],
    },
    "islamophobia": {
        "required": "针对穆斯林及来自伊斯兰国家的移民的公众恐惧（一种道德恐慌），有时导致仇恨言论与犯罪",
        "drop_examples": ["公众担心信奉伊斯兰教或来自伊斯兰国家的少数民族群体和移民",
                          "有时导致仇恨言论和犯罪"],
    },
    "marginalised masculinity": {
        "required": "因长期失业、家庭主要养家者角色逆转，而在社会与家庭中被边缘化的男性气质",
        "drop_examples": ["男性因长期失业而在社会中被边缘化", "男性因长期失业而在家庭中被边缘化",
                          "主要养家者角色的逆转导致其边缘化"],
    },
    "new man / new father": {
        "required": "愿与伴侣分担家务、平等且尊重地对待伴侣的新型男性与父亲",
        "drop_examples": ["与伴侣分担家务", "平等对待伴侣", "尊重伴侣"],
    },
    "pick and mix": {
        "required": "关于“个体身份是个人化的、且因人而异”的后现代主义隐喻",
        "drop_examples": ["个体身份被个性化", "个体身份在不同个体之间有所差异"],
    },
    "pentecostal church": {
        "required": "基督教的一个宗派（常为非裔美国人／加勒比黑人群体信仰，兼具文化防卫与新移民支持网络作用）",
        "drop_examples": ["常被非裔美国人 / 加勒比黑人群体共享", "对文化防卫有所贡献",
                          "为新移民提供支持网络"],
    },
    "silent generation": {
        "required": "美国“最伟大的一代”之后的一代：倾向在体制内工作、惧怕被视为反权威，因而持传统家庭观",
        "drop_examples": ["倾向于在体制内工作", "害怕被视为反对权威", "因此倾向于采纳传统的家庭观念"],
    },
    # 下面两条只补主干限定，举例本身是原文的 i.e./such as 枚举 → 保留
    "multifunctional": {
        "required": "（前工业时代的大家庭）同时满足成员的多种需求",
        "drop_examples": [],
    },
    "wealth": {
        "required": "累积的金钱及其他财产",
        "drop_examples": [],
    },
}


def load_env():
    env = {}
    for line in (ROOT / ".dev.vars").read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def cloud_main_defs(env):
    url = env["SUPABASE_URL"].rstrip("/")
    key = env["SUPABASE_ANON_KEY"]
    req = urllib.request.Request(
        f"{url}/rest/v1/vocab_releases?select=version,data&order=version.desc&limit=1",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Range": "0-4999"})
    with urllib.request.urlopen(req, timeout=90) as r:
        rel = json.loads(r.read().decode())
    if not rel:
        return 0, {}
    v = rel[0]
    out = {}
    for t in (v.get("data") or []):
        if t.get("type") != "term":
            continue
        k = norm(t.get("term"))
        d = (t.get("definition") or "").strip()
        if k and d and k not in out:
            out[k] = d
    return v.get("version"), out


def local_defs(fname, field="definition"):
    try:
        rows = json.loads((KEYTERMS / fname).read_text(encoding="utf-8"))
    except Exception:
        return {}
    out = {}
    for r in rows or []:
        k = norm(r.get("term"))
        d = (r.get(field) or r.get("def") or "").strip()
        if k and d and k not in out:
            out[k] = d
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--report", default="")
    args = ap.parse_args()

    env = load_env()
    version, main_defs = cloud_main_defs(env)
    tb1 = local_defs("tb1.json")
    tb2 = local_defs("tb2.json")
    ig = local_defs("igcse0495.json")

    pool = json.loads(POOL.read_text(encoding="utf-8"))
    out = [f"云端词库版本: v{version}", f"定义池条目: {len(pool)}",
           f"英文原文可用量: main {len(main_defs)} / tb1 {len(tb1)} / tb2 {len(tb2)} / 0495 {len(ig)}",
           "-" * 74]

    fixed, missing, n_en = [], [], 0
    for it in pool:
        k = norm(it.get("term"))
        # ① 主干修正
        fix = FIXES.get(k)
        if fix:
            req_idx = [i for i, kp in enumerate(it["keypoints"]) if kp.get("kind") != "example"]
            if len(req_idx) == 1:
                it["keypoints"][req_idx[0]]["text"] = fix["required"]
            else:
                # 主干不是 1 条时不动，只报告（避免误改）
                out.append(f"  !! {it['term']}: 主干 {len(req_idx)} 条，跳过改写")
            drops = {norm(x) for x in fix["drop_examples"]}
            before = len(it["keypoints"])
            it["keypoints"] = [kp for kp in it["keypoints"] if norm(kp.get("text")) not in drops]
            fixed.append((it["term"], before - len(it["keypoints"])))
        # ② source_defs
        defs = {}
        if k in main_defs:
            defs["main"] = main_defs[k]
        if k in tb1:
            defs["tb1"] = tb1[k]
        if k in tb2:
            defs["tb2"] = tb2[k]
        if k in ig:
            defs["igcse0495"] = ig[k]
        if defs:
            it["source_defs"] = defs
            n_en += 1
        else:
            it.pop("source_defs", None)
            missing.append(it["term"])

    out.append(f"主干修正: {len(fixed)} 条")
    for t, n in fixed:
        out.append(f"   ✓ {t}" + (f"（删除重复举例 {n} 项）" if n else "（举例保留）"))
    out.append("-" * 74)
    out.append(f"有英文原文（source_defs）: {n_en} / {len(pool)}")
    out.append(f"无任何英文原文: {len(missing)}")
    for t in missing[:40]:
        out.append(f"   ! {t}")
    if len(missing) > 40:
        out.append(f"   … 另有 {len(missing) - 40} 条")

    report = "\n".join(out)
    print(report)
    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")

    if args.write:
        POOL.write_text(json.dumps(pool, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"\n已写回 {POOL}")
    else:
        print("\n（dry-run，加 --write 生效）")


if __name__ == "__main__":
    main()
