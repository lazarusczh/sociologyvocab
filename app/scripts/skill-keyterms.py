# 教材 PDF → 「Key terms 结构化定义库」（术语 / 释义 / 章 / 节 / 页 + 抽取置信度）
#
# 背景：定义题判分需要「标准答案」，而两本 9699 教材每节末尾自带 Key terms 小节
# （术语 + 官方释义），OCR 版保留了加粗与字号，因此可全自动抽取、零人工录入。
#
# 两种版面（实测）：
#   tb1（Haralambos）：`[加粗 12.4] Key terms` 锚点，条目形如
#                      `[加粗] Social solidarity This involves a commitment` + 续行不加粗
#                      → 术语与释义首句在同一加粗行，无分隔符，靠「术语表反查 + 大小写边界」切分
#   tb2（Livesey）：   `KEY TERMS Conglomeration: when a media corporation ...`（术语: 释义）
#                      → 冒号分隔，直接正则切分
#
# 用法：
#   python scripts/skill-keyterms.py --book haralambos --out C:/tmp/kt-tb1
#   python scripts/skill-keyterms.py --book livesey   --out C:/tmp/kt-tb2
#   python scripts/skill-keyterms.py --book haralambos --out C:/tmp/kt-tb1 --inspect
import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import pymupdf

ONEDRIVE = Path("C:/Users/rebir/OneDrive")
ROOT = Path(__file__).resolve().parents[1]          # app/

BOOKS = {
    "haralambos": ("*Haralambos*.pdf", "tb1",
                   ["Introduction", "Socialisation and identity", "Research methods", "The family",
                    "Education", "The media", "Religion", "Globalisation", "Preparing for examinations"]),
    "livesey": ("*Livesey*.pdf", "tb2",
                ["Socialisation and the creation of social identity", "Methods of research", "The family",
                 "Education", "Globalisation", "Media", "Religion", "Preparing for assessment"]),
}

# 三份现成术语表，用于把「术语 + 释义首句」的加粗行切开（命中前缀即术语）
GLOSSARY_MD = {
    "tb1": Path("C:/Users/rebir/.agents/skills/9699textbook1/glossary.md"),
    "tb2": Path("C:/Users/rebir/.agents/skills/9699textbook2/glossary.md"),
}
VOCAB_JSON = ROOT / "public/vocab-data.json"

ANCHOR = re.compile(r"^\s*(?:J\s*)?KEY\s*TERMS\b", re.I)
COLON_ENTRY = re.compile(r"([A-Z][A-Za-z’'\- ]{2,48}?)\s*[:：]\s*")
MD_TERM = re.compile(r"^\*\*(.+?)\*\*\s*[—–-]\s*(.+)$")
# 加粗行里「术语 | 释义」的边界：
#   CASE_BOUND —— 小写词/右括号后紧跟一个大写开头的词（"Social solidarity This involves..."）
#   注意释义可能以单字母词开头（"…division of labour A labour force"），故允许 [A-Z] 后接空格
CASE_BOUND = re.compile(r"(?<=[a-z\)’'])\s+(?=[A-Z](?:[a-z]|\s))")
# 行首单术语 + 释义（"Meritocratic Description of a system…" / "Jim Crow laws State and local…"）
LEAD_BOUND = re.compile(r"^([A-Z][A-Za-z’'\-]+)\s+(?=[A-Z][a-z])")
# 正文编号列表（"2. A leading French sociologist…"）——不是 Key terms 条目
NUMBERED = re.compile(r"^\d{1,2}\.\s")


def pick_pdf(pattern: str) -> Path:
    cands = sorted(ONEDRIVE.glob(f"**/{pattern}"))
    if not cands:
        raise SystemExit(f"no pdf matched: {pattern}")
    ocr = [p for p in cands if "OCR" in p.name.upper()]
    return ocr[0] if ocr else cands[0]


def extract_page_rows(doc):
    """[(pno, [(text, size, bold, y0_ratio), ...])]"""
    out = []
    for i, page in enumerate(doc):
        try:
            d = page.get_text("dict")
            ph = page.rect.height or 1
        except Exception:
            out.append((i + 1, []))
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
                rows.append((txt, round(size, 1), bold, y0))
        out.append((i + 1, rows))
    return out


def load_term_map(book: str, extra: Path | None):
    """term(小写归一) → 展示用原形，用于切分加粗行。按长度降序消费。"""
    found = {}

    def add(t: str):
        t = re.sub(r"\s+", " ", (t or "")).strip(" .;:,")
        for part in re.split(r"[、,，/()（）]| vs | and ", t):
            s = part.strip()
            if 3 <= len(s) <= 48 and not s.lower().startswith(("see ", "cf.")):
                found.setdefault(s.lower(), s)

    if VOCAB_JSON.exists():
        data = json.loads(VOCAB_JSON.read_text(encoding="utf-8"))
        items = data if isinstance(data, list) else (data.get("items") or [])
        for it in items:
            add(it.get("term", ""))
    md = GLOSSARY_MD.get(book)
    if md and md.exists():
        for raw in md.read_text(encoding="utf-8").splitlines():
            m = MD_TERM.match(raw.strip())
            if m:
                add(m.group(1))
    if extra and Path(extra).exists():
        for it in json.loads(Path(extra).read_text(encoding="utf-8")):
            add(it.get("term") or it.get("en") or "")
    return dict(sorted(found.items(), key=lambda kv: -len(kv[0])))


def split_by_termtable(text: str, term_map):
    """术语表最长前缀匹配。返回 (term, rest) 或 (None, text)。"""
    low = text.lower()
    for key in term_map:                       # 已按长度降序
        if low.startswith(key):
            n = len(key)
            if n == len(low) or not low[n].isalnum():
                return term_map[key], text[n:].lstrip(" .:—-").strip()
    return None, text


# 术语表短命中后的补救：释义开头的 1–3 个「小写词」通常是被切开的多词术语尾
# （`Belief | system A set of ideas` → 术语其实是 "Belief system"；`radical | psychiatry A school`）
TAIL_WORDS = re.compile(r"^(?:[a-z][\w’'\-]*\s+){1,3}(?=[A-Z])")


def merge_tail(term: str, rest: str):
    m = TAIL_WORDS.match(rest or "")
    if m and len(term) + m.end() <= 48:
        return f"{term} {rest[:m.end()].strip()}", rest[m.end():].strip()
    return term, rest


def split_bold_entry(text: str, term_map):
    """加粗行 → (术语, 释义首段, 方法标记)。"""
    # 冒号版条目（tb2：`Patriarchal family: where the father…`）优先
    m = re.match(r"^([A-Z][^:：]{2,48}?)\s*[:：]\s*(.+)$", text)
    if m and len(m.group(2)) >= 10:
        return m.group(1).strip(" .,;:"), m.group(2).strip(), "colon-bold"
    term, rest = split_by_termtable(text, term_map)
    if term:
        return merge_tail(term, rest) + ("termtable",)
    m = CASE_BOUND.search(text)
    if m and m.end() <= 70:
        t = text[:m.start()].strip(" .,;:")
        if 1 <= len(t.split()) <= 7 and len(t) >= 3:
            return merge_tail(t, text[m.end() - 1:].strip()) + ("casebound",)
    m = LEAD_BOUND.match(text)
    if m and len(text) > m.end() + 12:          # 首词之后还有实质内容才算切分
        return merge_tail(m.group(1).strip(" .,;:"), text[m.end():].strip()) + ("leadbound",)
    return text.strip(" .,;:"), "", "whole-line"


def chapter_of(label: str, toc):
    low = (label or "").lower()
    for name in toc:
        if name.lower() in low:
            return name
    m = re.match(r"^\s*(\d{1,2})[\s.、-]", label or "")
    if m:
        n = int(m.group(1))
        if 1 <= n <= len(toc):
            return toc[n - 1]
    return None


def collect_sections(page_rows, toc):
    """定位所有 Key terms 小节 → [{page, chapter, section, rows:[(txt,size,bold)]}]"""
    sections = []
    cur_chapter = None
    for pno, rows in page_rows:
        header = ""
        for txt, size, bold, y0 in rows:
            if y0 < 0.10 and len(txt) < 90:
                header = txt
        ch = chapter_of(header, toc) or cur_chapter
        if ch:
            cur_chapter = ch

        anchor_i = None
        anchor_size = None
        inline = []                             # 锚点行内紧跟的首个条目（tb2：`J KEY TERMS Term: def…`）
        for i, (txt, size, bold, y0) in enumerate(rows):
            m = ANCHOR.search(txt)
            # 锚点两种形态：① 加粗标题行（术语随后同行或下行）；② 独立短行 "KEY TERMS"（个别章不设粗体）
            standalone = bool(re.fullmatch(r"\s*(?:J\s*)?KEY\s*TERMS\s*[:：]?\s*", txt, re.I))
            if m and ((bold and m.start() <= 15) or standalone) and len(txt) <= 220:
                anchor_i, anchor_size = i, size
                tail = txt[m.end():].strip(" .,;:")
                if len(tail) >= 12:
                    inline.append((tail, size, bold))
                break
        if anchor_i is None:
            continue

        body = list(inline)
        for txt, size, bold, y0 in rows[anchor_i + 1:]:
            if y0 > 0.93:                       # 页脚
                continue
            if re.fullmatch(r"[\d\s]+", txt) or NUMBERED.match(txt):
                break                           # 页码 / 正文编号列表 → Key terms 小节结束
            # 小节结束：出现比锚点更大的加粗标题（新章节标题）
            if bold and size >= (anchor_size or 0) + 0.6 and len(txt) > 12:
                break
            body.append((txt, size, bold))
        # tb1 版式：第一个加粗行才是条目起点；之前的非加粗残留（跨页延续的正文/页眉）丢弃。
        # 若整段没有任何加粗行，说明锚点是正文里顺带出现的 "Key terms"（如导论说明），直接跳过。
        first_bold = next((i for i, (_t, _s, b) in enumerate(body) if b), None)
        if first_bold is None:
            continue
        sections.append({"page": pno, "chapter": cur_chapter, "section": header,
                         "rows": body[first_bold:]})
    return sections


def entries_from_section(sec, term_map):
    """小节 → 条目列表。自动判断「冒号版」还是「加粗版」。"""
    joined = " ".join(t for t, _s, _b in sec["rows"])
    out = []
    has_bold = any(b for _t, _s, b in sec["rows"])
    # 冒号版仅用于「整段无加粗」的小节（tb2 版式），否则会被 tb1 正文里的冒号误判
    if (not has_bold) and len(COLON_ENTRY.findall(joined)) >= 2:
        # 冒号版（tb2）：按 "Term: definition" 全局切
        matches = list(COLON_ENTRY.finditer(joined))
        for k, m in enumerate(matches):
            end = matches[k + 1].start() if k + 1 < len(matches) else len(joined)
            term = m.group(1).strip(" .;:-")
            defn = joined[m.end():end].strip(" .;:-")
            if term and len(defn) >= 12:
                out.append({"term": term, "definition": defn, "method": "colon"})
        return out

    # 加粗版（tb1）：加粗行 = 条目起点，其后非加粗行续释义
    cur = None
    for txt, size, bold in sec["rows"]:
        if bold:
            if cur:
                out.append(cur)
            term, first, method = split_bold_entry(txt, term_map)
            cur = {"term": term, "definition": first, "method": method}
        elif cur:
            cur["definition"] = (cur["definition"] + " " + txt).strip()
    if cur:
        out.append(cur)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", required=True, choices=sorted(BOOKS))
    ap.add_argument("--out", required=True)
    ap.add_argument("--extra-terms", default="", help="补充术语表 JSON（[{term,def}]，如 0495 glossary）")
    ap.add_argument("--inspect", action="store_true", help="打印小节定位与抽样条目")
    args = ap.parse_args()

    pattern, slug, toc = BOOKS[args.book]
    pdf = pick_pdf(pattern)
    print(f"source: {pdf.name}")
    term_map = load_term_map(slug, Path(args.extra_terms) if args.extra_terms else None)
    print(f"term table: {len(term_map)} entries")

    doc = pymupdf.open(pdf)
    page_rows = extract_page_rows(doc)
    sections = collect_sections(page_rows, toc)
    print(f"pages={doc.page_count}  key-terms sections={len(sections)}")

    entries = []
    for sec in sections:
        got = entries_from_section(sec, term_map)
        for g in got:
            g.update({"book": slug, "page": sec["page"], "chapter": sec["chapter"],
                      "section": sec["section"]})
            entries.append(g)

    # 清洗：剔除明显非定义（过短、纯页码、符号噪声）
    clean = []
    for e in entries:
        t = re.sub(r"\s+", " ", e["term"]).strip(" .;:—-")
        d = re.sub(r"\s+", " ", e["definition"]).strip()
        if len(t) < 3 or not (15 <= len(d) <= 600):
            continue
        if t.lower().startswith(("activity", "evaluation", "summary", "questions")):
            continue
        # 术语形态过滤：教材术语是短名词短语（≤6 词）；借此挡掉导论页的整句说明文字
        if len(t.split()) > 6:
            continue
        if re.match(r"^J\s", t):
            continue
        if t.isupper() and len(t.split()) > 1:      # THINK LIKE A SOCIOLOGIST 这类版式标题
            continue
        e["term"], e["definition"] = t, d
        clean.append(e)

    # 去重：同书 + 同术语 + 同章取释义最长的一条（保留跨章多版本，供后续要素归纳合并）
    best = {}
    for e in clean:
        k = (e["book"], e["term"].lower(), e["chapter"])
        if k not in best or len(e["definition"]) > len(best[k]["definition"]):
            best[k] = e
    entries = sorted(best.values(), key=lambda e: (e["chapter"] or "", e["page"], e["term"]))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")

    by_method = Counter(e["method"] for e in entries)
    by_chapter = Counter(e["chapter"] or "front" for e in entries)
    avg = sum(len(e["definition"]) for e in entries) / max(1, len(entries))
    print(f"\nentries kept={len(entries)}  (raw={len(clean)}, sections={len(sections)})")
    print(f"  method: {dict(by_method)}")
    print(f"  avg definition length={avg:.0f} chars")
    print("  by chapter:")
    for ch, n in by_chapter.most_common():
        print(f"    {n:4d}  {ch}")
    print(f"\nwrote {out} ({out.stat().st_size} bytes)")

    if args.inspect:
        print("\n=== sample entries (every Nth) ===")
        step = max(1, len(entries) // 25)
        for e in entries[::step][:25]:
            print(f"  [p{e['page']} {e['method']}] {e['term']} :: {e['definition'][:120]}")
        weak = [e for e in entries if e["method"] != "termtable"]
        print(f"\n=== non-termtable samples ({len(weak)}) ===")
        for e in weak[:12]:
            print(f"  [p{e['page']} {e['method']}] {e['term']} :: {e['definition'][:110]}")


if __name__ == "__main__":
    main()
