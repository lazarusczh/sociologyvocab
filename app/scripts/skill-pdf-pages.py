# 教材 PDF → 「页级原文 + 页级索引」，供知识库做两级检索：
#   常驻前端：索引（章/节标签 + 关键词，体积小）
#   按需拉取：命中的若干页原文（完整，不切块、不摘要，细节不丢）
#
# 设计要点：
# 1) 页是天然的切分单位 —— 不需要识别标题层级，绕开切块调参的脆弱环节。
# 2) 页眉（每页顶部重复栏名，如 "5.7 GENDER AND EDUCATIONAL ATTAINMENT"）
#    不丢弃，而是当作该页的「节标签」，正好提供章节归属与打分关键词。
# 3) 关键词自动抽取：首字母大写词（Ward / Geeks / Boiz）、带年份的引用
#    （Ward (2015)）、全大写缩写（GCSE / SFP）、该页高频实词（小写主题词）。
#    这样正文细节（不在任何标题里的研究案例）也能被索引命中。
# 4) 全程无 LLM、无手工标注；教材换版重跑即可。
#
# 用法（参数用 ASCII，PDF 路径内部用 glob 解析，绕开 shell 中文编码问题）：
#   python scripts/skill-pdf-pages.py --book haralambos --out C:/tmp/tb1-pages
#   python scripts/skill-pdf-pages.py --book haralambos --out C:/tmp/tb1-pages --find Ward
import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import pymupdf

ONEDRIVE = Path("C:/Users/rebir/OneDrive")

BOOKS = {
    "haralambos": (
        "*Haralambos*.pdf",
        "tb1",
        ["Introduction", "Socialisation and identity", "Research methods", "The family",
         "Education", "The media", "Religion", "Globalisation", "Preparing for examinations"],
    ),
    "livesey": (
        "*Livesey*.pdf",
        "tb2",
        ["Socialisation and the creation of social identity", "Methods of research", "The family",
         "Education", "Globalisation", "Media", "Religion", "Preparing for assessment"],
    ),
}

STOP_EN = set(
    "a an the and or but of to in for on with by at from as is are was were be been being it its this that these those they them their he she his her we our you your not no do does did have has had what which who whom whose when where why how can could would should may might must about into than then also more most such only just because if there here their there some any all one two three four five six seven eight nine ten other others new first second same different more less very much many".split()
)

CAP_WORD = re.compile(r"\b[A-Z][a-z]{2,}\b")
UNIT_LINE = re.compile(r"^\s*Unit\s+(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)\s+(.+)$")
TERM_LINE = re.compile(r"^\*\*(.+?)\*\*\s*[—–-]\s*(.+)$")

# 蒸馏 skill 的术语表：`**English Term** — 中文释义 (Ch N)`。
# 抽成「中文译名 → 英文术语」桥：中文提问先查本地词典（零延迟），查不到才调模型翻译。
GLOSSARY = {
    "tb1": Path("C:/Users/rebir/.agents/skills/9699textbook1/glossary.md"),
    "tb2": Path("C:/Users/rebir/.agents/skills/9699textbook2/glossary.md"),
}


def parse_glossary_terms(path: Path):
    """`**Term** — 中文释义` → [{zh, en}]，zh 取释义开头的中文译名（到首个分隔符为止）。"""
    out = []
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        m = TERM_LINE.match(raw.strip())
        if not m:
            continue
        en = m.group(1).strip()
        defn = re.sub(r"\((?:[^()]*Ch[^()]*)\)\s*$", "", m.group(2).strip()).strip()
        zh = re.sub(r"[^\u4e00-\u9fff]", "", re.split(r"[：:，,；;（(]", defn)[0])
        if 2 <= len(zh) <= 12:
            out.append({"zh": zh, "en": en})
    return out
YEAR_REF = re.compile(r"\b([A-Z][\w'&-]+(?:\s+&\s+[A-Z][\w'&-]+)?)\s*\(\s*(\d{4})\s*\)")
ACRONYM = re.compile(r"\b[A-Z]{2,6}\b")
LOWER_WORD = re.compile(r"[a-z]{5,}")


def pick_pdf(pattern: str) -> Path:
    cands = sorted(ONEDRIVE.glob(f"**/{pattern}"))
    if not cands:
        raise SystemExit(f"no pdf matched: {pattern}")
    ocr = [p for p in cands if "OCR" in p.name.upper()]
    return ocr[0] if ocr else cands[0]


def extract_page_rows(doc):
    """返回 [(pno, [(text, size, bold, y0_ratio), ...])]"""
    out = []
    for i, page in enumerate(doc):
        pno = i + 1
        try:
            d = page.get_text("dict")
            ph = page.rect.height or 1
        except Exception:
            out.append((pno, []))
            continue
        rows = []
        for blk in d.get("blocks", []):
            if blk.get("type", 0) != 0:
                continue
            for ln in blk.get("lines", []):
                spans = ln.get("spans", [])
                if not spans:
                    continue
                txt = "".join(s.get("text", "") for s in spans).strip()
                if not txt:
                    continue
                size = max(s.get("size", 0) for s in spans)
                bold = any("bold" in (s.get("font", "") or "").lower() for s in spans)
                y0 = ln.get("bbox", [0, 0, 0, 0])[1] / ph
                rows.append((txt, size, bold, y0))
        out.append((pno, rows))
    return out


def build_boilerplate(page_rows, total_pages):
    """页眉页脚：位于页首/页尾且跨 >=3 页重复出现的行。"""
    edge = defaultdict(set)
    for pno, rows in page_rows:
        for txt, size, bold, y0 in rows:
            if len(txt) > 80:
                continue
            if y0 < 0.10 or y0 > 0.90:
                edge[txt].add(pno)
    return {t for t, pages in edge.items() if len(pages) >= 3}


def chapter_of(label: str, toc):
    low = (label or "").lower()
    for name in toc:
        if name.lower() in low:
            return name
    m = re.match(r"^\s*(\d{1,2})[\s.、-]", label or "") or re.search(r"Unit\s+(\d{1,2})[\s.、-]", label or "")
    if m:
        n = int(m.group(1))
        if 1 <= n <= len(toc):
            return toc[n - 1]
    return None


def keywords(text: str, glossary_terms=(), limit: int = 70):
    """自动抽关键词：教材术语命中 / 大写词（去句首停用词）/ 带年份引用 / 缩写 / 本页高频实词。"""
    kws = set()
    low = text.lower()

    # 1) 教材术语命中（优先，不被上限挤掉）：低频概念（asceticism / attrition / catharsis…）
    #    只出现在正文一两处，进不了高频词；这里按术语候选做「词形宽松」查找，
    #    并把正文里的实际形式（如 sociobiologists）收进索引，便于检索端做前缀匹配。
    term_hits = []
    for key in glossary_terms:
        m = re.search(r"(?<![a-z])" + re.escape(key) + r"[a-z]*", low)
        if m:
            term_hits.append(m.group(0))

    for w in CAP_WORD.findall(text):
        wl = w.lower()
        if wl not in STOP_EN:          # 句首 This / They / How 这类词不该进索引
            kws.add(wl)
    for name, year in YEAR_REF.findall(text):
        base = name.lower().strip()
        kws.add(base)
        kws.add(f"{base} {year}")
        for part in re.split(r"\s+&\s+", base):
            if part:
                kws.add(part)
    for a in ACRONYM.findall(text):
        kws.add(a.lower())
    freq = Counter(w for w in LOWER_WORD.findall(low) if w not in STOP_EN)
    for w, _c in freq.most_common(12):
        kws.add(w)

    term_set = set(term_hits)
    ordered = sorted(term_set) + [w for w in sorted(kws) if w not in term_set]
    return ordered[:limit]


def slugify(s: str, limit: int = 40) -> str:
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE).strip().lower()
    return re.sub(r"\s+", "-", s)[:limit] or "chapter"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", required=True, choices=sorted(BOOKS))
    ap.add_argument("--out", required=True)
    ap.add_argument("--find", default="", help="打印含该关键词的页（索引条目 + 原文片段），用于回归验证")
    args = ap.parse_args()

    pattern, slug, toc = BOOKS[args.book]
    pdf = pick_pdf(pattern)
    print(f"source: {pdf.name}")

    doc = pymupdf.open(pdf)
    page_rows = extract_page_rows(doc)
    total_pages = doc.page_count
    boiler = build_boilerplate(page_rows, total_pages)
    print(f"pages={total_pages} boilerplate_lines={len(boiler)}")

    # 术语表先解析：既作为「中英术语桥」输出，也用于给页索引补低频概念关键词。
    # glos_keys 里额外加入「去尾字母」的词干变体，用于发现词形变化
    # （如术语表 sociobiology ↔ 正文 sociobiologists）。
    terms = parse_glossary_terms(GLOSSARY.get(slug, Path("__missing__")))
    glos_keys = set()
    for t in terms:
        for part in re.split(r"[、,，/()（）]", t["en"]):
            s = part.strip().lower()
            if len(s) < 4 or s in {"vs", "and", "or", "the"}:
                continue
            glos_keys.add(s)
            if "-" in s:                      # 术语表用连字符、正文常无（under-achievement ↔ underachievement）
                glos_keys.add(s.replace("-", ""))
            if " " not in s and len(s) >= 8:
                glos_keys.add(s[:-1])
            elif " " in s:
                head = s.rsplit(" ", 1)[0]
                if len(head) >= 6:
                    glos_keys.add(head)
    glos_keys = sorted(glos_keys)

    pages = []   # {p, chapter, section, text}
    index = []   # {p, c, s, k}
    cur_chapter = None
    unit_rows = []   # (unit, title, pno, size)：正文里的 Unit 标题行

    for pno, rows in page_rows:
        header_texts = []
        body = []
        for txt, size, bold, y0 in rows:
            um = UNIT_LINE.match(txt)
            if um:
                unit_rows.append((um.group(1), re.sub(r"\s+", " ", um.group(2)).strip(), pno, size))
            if txt in boiler:
                if y0 < 0.10:      # 页顶栏名 → 该页的节标签
                    header_texts.append(txt)
                continue
            if re.fullmatch(r"[\d\s]+", txt):
                continue
            body.append(txt)
        section = " ".join(header_texts).strip()
        section = re.sub(r"\s+", " ", section)[:120]
        ch = chapter_of(section, toc) or cur_chapter
        if ch:
            cur_chapter = ch
        text = re.sub(r"\s+", " ", " ".join(body)).strip()
        if len(text) < 80:
            continue        # 空白页/图片页/分隔页
        pages.append({"p": pno, "chapter": cur_chapter, "section": section, "text": text})
        index.append({"p": pno, "c": cur_chapter, "s": section, "k": keywords(text, glos_keys)})

    print(f"usable pages={len(pages)}")

    # Unit → 起始页：只取「标题字号」的 Unit 行——正文里 "see Unit 5.1.2" 这类引用是正文字号，
    # 与标题字号相差 7pt 左右，据此天然排除，无需人工标注。
    units = {}
    if unit_rows:
        # 用「众数字号」而非最大字号做阈值：个别装饰性大标题会把阈值顶飞
        size_hist = Counter(round(r[3]) for r in unit_rows)
        title_size = size_hist.most_common(1)[0][0]
        for unit, title, pno, size in sorted(unit_rows, key=lambda r: r[2]):
            if round(size) < title_size - 1:
                continue
            if unit not in units:
                units[unit] = {"title": title[:90], "page": pno}
    seen_units = {r[0] for r in unit_rows}
    print(f"units: mapped={len(units)} / seen={len(seen_units)}")

    # 章 → 起始页（无 Unit 编号体系的教材也能用：起「范围收缩」与出处标注作用）
    chapters_map = {}
    for pg in pages:
        ch = pg["chapter"] or "front"
        if ch not in chapters_map:
            chapters_map[ch] = {"page": pg["p"]}
    print(f"chapters mapped={len(chapters_map)}")

    out_dir = Path(args.out)
    pages_dir = out_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)

    by_chapter = defaultdict(list)
    for pg in pages:
        by_chapter[pg["chapter"]].append({"p": pg["p"], "t": pg["text"]})

    total_chars = 0
    for ch, items in by_chapter.items():
        name = f"{slug}-{slugify(ch or 'front')}.json"
        blob = json.dumps({"book": slug, "chapter": ch, "pages": items}, ensure_ascii=False)
        (pages_dir / name).write_text(blob, encoding="utf-8")
        total_chars += len(blob)
        print(f"  {name}: {len(items)} pages, {len(blob)} chars")

    print(f"term bridge: {len(terms)} entries")

    idx_blob = json.dumps(
        {"book": slug, "pages": index, "units": units, "chapters": chapters_map, "terms": terms},
        ensure_ascii=False,
    )
    (out_dir / "index.json").write_text(idx_blob, encoding="utf-8")
    (out_dir / "meta.json").write_text(
        json.dumps({"source": pdf.name, "book": slug, "pages": total_pages,
                    "usable": len(pages), "chapters": list(by_chapter)},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"index.json: {len(idx_blob)} chars ({len(idx_blob)/1024:.0f} KB)")
    print(f"pages total: {total_chars} chars ({total_chars/1024/1024:.2f} MB)")

    if args.find:
        kw = args.find.lower()
        print(f"\n=== probe '{args.find}' ===")
        hits = [e for e in index if kw in " ".join(e["k"])]
        print(f"index hits: {len(hits)} pages -> {[e['p'] for e in hits][:20]}")
        for e in hits[:5]:
            raw = next((p["text"] for p in pages if p["p"] == e["p"]), "")
            i = raw.lower().find(kw)
            print(f"  p{e['p']} [{e['c']}] {e['s'][:60]}")
            print(f"     kw: {', '.join(e['k'][:18])}")
            print(f"     ...{raw[max(0,i-160):i+260]}...")


if __name__ == "__main__":
    main()
