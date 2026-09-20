"""把定义池（definition-keypoints.json）的元数据同步到云端最新词库。

为什么需要：定义池是从本地 `public/vocab-data.json` 快照生成的；教师在主站改词库
（改术语名、拆分单元）并发布新版后，定义池的 term/paper/unit 会变成旧值 ——
典型症状：云端把「社会化和社会控制」拆成「社会化」+「叛逆与社会控制」，
于是定义题按这两个单元筛选都是 0 条（73 条术语失联）。

本脚本**只改 term / paper / unit 三个字段**，不动 keypoints（不重跑 LLM、不耗额度）。
匹配用「去引号 + 小写 + 空白归一」，因此弯引号/直引号差异（’Go native' vs 'Go native'）
也能对上。

孤儿术语（云端已改名或已并入其它条目）默认只报告；加 `--handle-orphans` 才处理：
  · ORPHAN_RENAME 里的按云端新名改名；
  · ORPHAN_DROP 里的从池中移除，并输出 SQL 把库内旧行 active 置 false
    （不能只依赖重新导入：definition-import.mjs 会把 active 写回 true）。

用法：
  python scripts/definition-sync-meta.py                       # dry-run，只报告
  python scripts/definition-sync-meta.py --handle-orphans      # dry-run + 预览孤儿处理
  python scripts/definition-sync-meta.py --write --handle-orphans \
      --report C:/tmp/sync.txt --sql-deactivate C:/tmp/deactivate.sql
"""
import argparse
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POOL = ROOT / "data/definition-keypoints.json"

# 归一化时一律丢弃的引号字符（含弯/直/单双/反引号）
QUOTES = "‘’“”'\"`´"

# ---- 孤儿术语处理（2026-09-20 对照云端 v96 逐一核实）----
# 云端已改名：按新名继续匹配并更新
ORPHAN_RENAME = {
    "cultural factor (deprivation)": "Cultural factor",     # 云端去掉了括号限定
}
# 云端已并入其它条目 / 已删除：从池中移除（库内旧行需 active=false）
ORPHAN_DROP = [
    "Scapegoat",             # → Scapegoating
    "Folk devil",            # → Folk devils
    "Multiculturalism",      # → Multiculturalism (= Cultural diversity)
    "Cultural diversity",    # → 同上（同一概念的旧重复条目）
    "Particularism",         # → Particularistic value
    "Universalism",          # → Universalistic value
    "Consensus",             # 云端已删（仅剩 Value consensus）
    "Hyper-Globalism",       # 云端已删
]


def norm(s: str) -> str:
    """术语归一化：去引号 + 小写 + 压缩空白 + 斜杠两侧空格统一"""
    s = (s or "").strip().lower()
    s = s.translate(str.maketrans({c: "" for c in QUOTES}))
    s = re.sub(r"\s*/\s*", " / ", s)
    s = re.sub(r"[\s\u00a0]+", " ", s)
    return s


def slug(t: str, i: int = 0) -> str:
    """与 definition-import.mjs 的 slug 保持一致（用于生成停用 SQL 的 id）"""
    s = re.sub(r"[^a-z0-9]+", "-", str(t or "").lower()).strip("-")[:60]
    return s or f"item-{i}"


def ulist(x):
    if isinstance(x, str):
        return [x] if x.strip() else []
    return [i for i in (x or []) if i]


def load_env() -> dict:
    env = {}
    for line in (ROOT / ".dev.vars").read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def fetch_cloud(env: dict):
    url = env["SUPABASE_URL"].rstrip("/")
    key = env["SUPABASE_ANON_KEY"]
    req = urllib.request.Request(
        f"{url}/rest/v1/vocab_releases?select=version,unit_order,data&order=version.desc&limit=1",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Range": "0-4999"})
    with urllib.request.urlopen(req, timeout=90) as r:
        rel = json.loads(r.read().decode())
    if not rel:
        raise SystemExit("vocab_releases 读不到（RLS？）")
    v = rel[0]
    terms = [x for x in (v.get("data") or []) if x.get("type") == "term"]
    return v.get("version"), terms, (v.get("unit_order") or {})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="写回 definition-keypoints.json")
    ap.add_argument("--report", default="", help="把报告写入该文件")
    ap.add_argument("--handle-orphans", action="store_true",
                    help="按 ORPHAN_RENAME 改名、按 ORPHAN_DROP 移除并从库里停用")
    ap.add_argument("--sql-deactivate", default="", help="输出停用 SQL 到该文件")
    args = ap.parse_args()

    env = load_env()
    version, cloud_terms, unit_order = fetch_cloud(env)

    idx: dict[str, list] = {}
    for t in cloud_terms:
        idx.setdefault(norm(t.get("term")), []).append(t)

    pool = json.loads(POOL.read_text(encoding="utf-8"))
    out = [f"云端词库版本: v{version}", f"云端 term 行数: {len(cloud_terms)}",
           f"定义池条目数: {len(pool)}", "-" * 74]

    n_match = n_term = n_paper = n_unit = 0
    renamed, orphans, changes, dropped = [], [], [], []
    drop_keys = {norm(x) for x in ORPHAN_DROP}

    for it in pool:
        if args.handle_orphans and norm(it.get("term")) in drop_keys:
            dropped.append(it.get("term"))
            continue
        k = norm(it.get("term"))
        rows = idx.get(k)
        if not rows and args.handle_orphans and k in ORPHAN_RENAME:
            new_name = ORPHAN_RENAME[k]
            rows = idx.get(norm(new_name))
            if rows:
                renamed.append((it.get("term"), new_name))
                it["term"] = new_name
        if not rows:
            orphans.append(it.get("term"))
            continue
        n_match += 1
        cur_paper = it.get("paper") or ""
        chosen = next((r for r in rows if (r.get("paper") or "") == cur_paper), rows[0])
        new_term = (chosen.get("term") or it.get("term")).strip()
        new_paper = (chosen.get("paper") or cur_paper).strip()
        merged = []
        for r in rows:
            for u in ulist(r.get("unit")):
                if u not in merged:
                    merged.append(u)
        old_units = ulist(it.get("unit"))
        diffs = []
        if (it.get("term") or "").strip() != new_term:
            n_term += 1
            diffs.append(f"term: {it.get('term')!r} → {new_term!r}")
            it["term"] = new_term
        if new_paper and new_paper != cur_paper:
            n_paper += 1
            diffs.append(f"paper: {cur_paper} → {new_paper}")
            it["paper"] = new_paper
        if merged and merged != old_units:
            n_unit += 1
            diffs.append(f"unit: {old_units} → {merged}")
            it["unit"] = merged
        if diffs:
            changes.append((it.get("term"), diffs))

    if dropped:
        drop_set = {norm(x) for x in dropped}
        pool = [it for it in pool if norm(it.get("term")) not in drop_set]

    out += [
        f"匹配成功: {n_match} / 原 {len(pool) + len(dropped)}",
        f"  · term 变更（含引号归一 / 孤儿改名）: {n_term + len(renamed)}",
        f"  · paper 变更: {n_paper}",
        f"  · unit  变更: {n_unit}",
    ]
    if renamed:
        out.append(f"孤儿改名: {len(renamed)}")
        for a, b in renamed:
            out.append(f"    ~ {a} → {b}")
    if dropped:
        out.append(f"孤儿移除（云端已并入别处/已删）: {len(dropped)}")
        for t in dropped:
            out.append(f"    - {t}")
    remaining = [t for t in orphans if t not in dropped]
    out.append(f"仍未匹配: {len(remaining)}")
    for t in remaining:
        out.append(f"    ! {t}")

    out.append("-" * 74)
    out.append("unit 变更明细（前 30 条）：")
    shown = 0
    for term, diffs in changes:
        hit = [d for d in diffs if d.startswith("unit")]
        if not hit:
            continue
        out.append(f"  {term}: {hit[0][6:]}")
        shown += 1
        if shown >= 30:
            out.append("  ...")
            break

    from collections import Counter
    cnt = Counter()
    for it in pool:
        for u in ulist(it.get("unit")):
            cnt[u] += 1
    cloud_unit_names = sorted({u for lst in unit_order.values() for u in lst})
    out.append("-" * 74)
    out.append("unit_order 各单元在池内的条数：")
    zero = [u for u in cloud_unit_names if cnt.get(u, 0) == 0]
    for u in cloud_unit_names:
        out.append(f"  {u}: {cnt.get(u, 0)}" + ("   ← 0 条！" if cnt.get(u, 0) == 0 else ""))
    leftover = sorted(set(cnt) - set(cloud_unit_names))
    out.append(f"0 条单元: {zero or '无'}")
    out.append(f"池内旧/未知单元名: {leftover or '无'}")
    out.append(f"同步后池内条目数: {len(pool)}")

    report = "\n".join(out)
    print(report)
    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")
        print(f"\n报告已写入 {args.report}")

    # 生成停用 SQL（库内旧行；重新导入不会自动停用它们）
    if args.sql_deactivate and dropped:
        ids = [slug(t, i) for i, t in enumerate(dropped)]
        sql = ("-- 定义池孤儿术语停用（云端已并入其它条目或删除）\n"
               "-- 由 scripts/definition-sync-meta.py 生成；幂等\n"
               f"update definition_items set active = false, updated_at = now()\n"
               f" where id in ({', '.join(repr(x) for x in ids)});\n")
        Path(args.sql_deactivate).write_text(sql, encoding="utf-8")
        print(f"停用 SQL 已写入 {args.sql_deactivate}（{len(ids)} 条）")

    if args.write:
        POOL.write_text(json.dumps(pool, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"\n已写回 {POOL}")
    else:
        print("\n（dry-run：未改动文件，加 --write 生效）")


if __name__ == "__main__":
    main()
