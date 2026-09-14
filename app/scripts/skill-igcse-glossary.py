# 0495 / 2251 官方 Glossary（PDF）→ 结构化定义 [{term, definition, page}]
#
# 版面（实测）：两列表格
#   Terms      x0 ≈ 62     Definition  x0 ≈ 201
#   术语行与释义首行同一 y；释义可跨多行。
# 因此按 x0 分列 + 按 y 顺序配对即可精确还原，避免"整句当术语/释义串行"的错位。
#
# 用法: python scripts/skill-igcse-glossary.py --out app/data/ms-skill/keyterms/igcse0495.json
import argparse
import json
import re
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PDF = ROOT.parent / "Materials/04952251 Glossary (for examination from 2025).pdf"
LEFT_MAX = 150.0                       # 术语列 x0 上限（释义列从 ~201 开始）
SKIP = re.compile(r"^(terms|definition|glossary|\d{1,3})$", re.I)


def parse_pdf(pdf: Path):
    doc = pymupdf.open(pdf)
    entries, cur, cur_page = [], None, 0
    for pno, page in enumerate(doc, 1):
        rows = []
        for blk in page.get_text("dict").get("blocks", []):
            if blk.get("type", 0) != 0:
                continue
            for ln in blk.get("lines", []):
                txt = "".join(s.get("text", "") for s in ln.get("spans", [])).strip()
                if not txt or SKIP.match(txt):
                    continue
                x0, y0 = ln["bbox"][0], ln["bbox"][1]
                rows.append((y0, x0, txt))
        rows.sort(key=lambda r: (r[0], r[1]))          # 先按 y，再按 x（同行左列先出）
        for _y, x0, txt in rows:
            if x0 < LEFT_MAX:
                if cur:
                    entries.append(cur)
                cur = {"term": re.sub(r"\s+", " ", txt), "definition": "", "page": pno}
            elif cur:
                cur["definition"] = (cur["definition"] + " " + txt).strip()
            cur_page = pno
    if cur:
        entries.append(cur)

    out = []
    for e in entries:
        t = re.sub(r"\s+", " ", e["term"]).strip(" .;:—-")
        d = re.sub(r"\s+", " ", e["definition"]).strip()
        if len(t) < 3 or len(d) < 12 or t[0].isdigit():
            continue
        out.append({"term": t, "definition": d, "page": e["page"]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default=str(DEFAULT_PDF))
    ap.add_argument("--out", default=str(ROOT / "data/ms-skill/keyterms/igcse0495.json"))
    ap.add_argument("--inspect", action="store_true")
    args = ap.parse_args()

    pdf = Path(args.pdf)
    if not pdf.exists():
        cands = list(Path("C:/Users/rebir/OneDrive").rglob("*Glossary*0495*.pdf")) + \
                list(Path("C:/Users/rebir/OneDrive").rglob("*Glossary*2251*.pdf"))
        if not cands:
            raise SystemExit(f"glossary pdf not found: {pdf}")
        pdf = cands[0]
    print("source:", pdf.name)

    entries = parse_pdf(pdf)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"entries={len(entries)}  →  {out}")

    if args.inspect:
        print("\n=== first 8 ===")
        for e in entries[:8]:
            print(f"  p{e['page']:3d} {e['term'][:38]:40s} :: {e['definition'][:95]}")
        print("\n=== last 6 ===")
        for e in entries[-6:]:
            print(f"  p{e['page']:3d} {e['term'][:38]:40s} :: {e['definition'][:95]}")
        print("\n=== spot check (Vocationalism / Warm bath / Peer group) ===")
        for key in ("Vocationalism", "Warm bath", "Peer group", "Achieved status"):
            for e in entries:
                if key.lower() in e["term"].lower():
                    print(f"  {e['term']} :: {e['definition'][:120]}")
                    break


if __name__ == "__main__":
    main()
