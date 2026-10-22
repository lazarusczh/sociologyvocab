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
    "tb3": Path("C:/Users/rebir/.agents/skills/keyconcepts/chapters"),
}

# 章名归一化：蒸馏章标题 → 与页索引一致的章名
TOC = {
    "tb1": ["Introduction", "Socialisation and identity", "Research methods", "The family",
            "Education", "The media", "Religion", "Globalisation", "Preparing for examinations"],
    "tb2": ["Socialisation and the creation of social identity", "Methods of research", "The family",
            "Education", "Globalisation", "Media", "Religion", "Preparing for assessment"],
    "tb3": ["Sociological Theory and Perspectives", "Culture, Identity and Socialisation",
            "Family and Households", "Education", "Work, Class and Inequality", "Crime and Deviance",
            "Media, Globalisation and Belief Systems", "Research Methods"],
}

# 词典式教辅的特殊处理：页级检索的「章」是概念条目（77 个），蒸馏章却是 8 个主题，
# 两边章名对不上 ⇒ 按命中章注入脚手架的机制会静默失效。
# 这里把每个主题的脚手架铺到它覆盖的每个概念上，使按概念命中的页也能拿到教师口径。
FANOUT = {
    "tb3": {
        "Sociological Theory and Perspectives": [
            "Agency and structure", "Functionalism", "Marxism", "Weberianism",
            "Symbolic interactionism", "Interpretivism", "Positivism", "Postmodernism",
            "Social facts", "Verstehen", "Organic analogy", "Sociological imagination", "Feminism"],
        "Culture, Identity and Socialisation": [
            "Culture", "Norms", "Values", "Roles", "Status", "Socialisation", "Identity",
            "Ethnocentrism", "Assimilation", "Multiculturalism", "Rites of passage",
            "Nature versus nurture", "Femininities", "Masculinities"],
        "Family and Households": [
            "Beanpole family", "Cereal packet family", "Confluent love", "Conjugal roles",
            "Dark side of family life", "Empty-shell marriage", "Patriarchy", "Warm bath theory"],
        "Education": [
            "Correspondence principle", "Hidden curriculum", "Marketisation of education",
            "Meritocracy", "Self-fulfilling prophecy"],
        "Work, Class and Inequality": [
            "Capital", "Canteen culture", "Consumer culture", "Deskilling", "Disneyization",
            "Fordism", "Glass ceiling", "Habitus", "Life chances", "McDonaldization", "NEETs",
            "Poverty", "Reserve army of labour", "Social class", "Social closure", "Social mobility",
            "Underclass"],
        "Crime and Deviance": [
            "Anomie", "Deviance", "Institutional racism", "Left and right realism", "Moral panic",
            "Social control", "Subculture", "White-collar crime"],
        "Media, Globalisation and Belief Systems": [
            "Globalisation", "Hybridity", "Mass media", "New Age Movements",
            "NRMs (New Religious Movements)", "Secularisation"],
        "Research Methods": [
            "Ethics in research", "Qualitative data", "Quantitative data", "Reliability",
            "Representativeness", "Triangulation", "Validity"],
    },
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

    for book, mapping in FANOUT.items():
        theme_data = dict(data.get(book, {}))
        for theme, concepts in mapping.items():
            picked = theme_data.get(theme)
            if not picked:
                print(f"  WARN {book}: 主题章未抽到脚手架 -> {theme}")
                continue
            for concept in concepts:
                data[book][concept] = picked

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
