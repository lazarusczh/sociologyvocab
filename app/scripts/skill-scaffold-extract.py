# 从蒸馏教材章里抽取「答题脚手架」（Mental Models / Anti-patterns / Key Takeaways），
# 按章存入 skill_scaffolds —— 作答时按命中的章注入，给弱模型（8B 兜底）一个结构模板，
# 同时把教师的答题口径（如教育的 material → cultural → in-school 三层）带进回答。
#
# 用法：
#   python scripts/skill-scaffold-extract.py --out C:/tmp/skill-scaffolds.sql
import argparse
import json
import re
from pathlib import Path

SOURCES = {
    "tb1": Path("C:/Users/rebir/.agents/skills/9699textbook1/chapters"),
    "tb2": Path("C:/Users/rebir/.agents/skills/9699textbook2/chapters"),
}

# 章名归一化：蒸馏章标题 → 与页索引一致的章名
TOC = {
    "tb1": ["Introduction", "Socialisation and identity", "Research methods", "The family",
            "Education", "The media", "Religion", "Globalisation", "Preparing for examinations"],
    "tb2": ["Socialisation and the creation of social identity", "Methods of research", "The family",
            "Education", "Globalisation", "Media", "Religion", "Preparing for assessment"],
}

WANT = ("Mental Models", "Anti-patterns", "Key Takeaways")
LIMITS = {"Mental Models": 1400, "Anti-patterns": 900, "Key Takeaways": 700}


def split_sections(md: str):
    """按 ## 切片，返回 {小节名: [行…]}"""
    out, cur = {}, None
    for line in md.splitlines():
        m = re.match(r"^##\s+(.+)$", line)
        if m:
            cur = m.group(1).strip()
            out.setdefault(cur, [])
        elif cur is not None:
            out[cur].append(line.rstrip())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    data = {}
    for book, dirp in SOURCES.items():
        data[book] = {}
        for f in sorted(dirp.glob("*.md")):
            md = f.read_text(encoding="utf-8")
            title = md.splitlines()[0].lstrip("# ").strip()
            low = title.lower()
            ch = next((n for n in TOC[book] if n.lower() in low), None)
            if not ch:
                continue
            secs = split_sections(md)
            picked = {}
            for key in WANT:
                txt = "\n".join(x for x in (secs.get(key) or []) if x.strip())
                if txt:
                    picked[key] = txt[: LIMITS[key]]
            if picked:
                data[book][ch] = picked

    q = lambda s: "'" + str(s).replace("'", "''") + "'"
    lines = ["begin;"]
    total = 0
    for book, chapters in data.items():
        for ch, picked in chapters.items():
            lines.append(
                f"insert into skill_scaffolds (book, chapter, data) values "
                f"({q(book)}, {q(ch)}, {q(json.dumps(picked, ensure_ascii=False))}::jsonb) "
                f"on conflict (book, chapter) do update set data = excluded.data;"
            )
            total += 1
    lines.append("commit;")
    Path(args.out).write_text("\n".join(lines), encoding="utf-8")
    print(f"scaffolds: {total} chapters, sql={args.out}")
    for book, chapters in data.items():
        print(f"  {book}: {', '.join(chapters)}")


if __name__ == "__main__":
    main()
