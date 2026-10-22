# 联网检索「质量」评估（本机）：不测可达性，只测召回有没有用
#
# 与 web-search-probe.py 的分工：
#   web-search-probe.py  → 能不能打到、返回结构长什么样（key / 可达性）
#   web-search-eval.py   → 打到了之后，返回的东西是不是我们要的（召回质量 / 口径对比）
#
# 用法：
#   python app/scripts/web-search-eval.py                 # 全部（5 个 9699 问题 × Tavily + OpenAlex 3 口径）
#   python app/scripts/web-search-eval.py --only tavily
#   python app/scripts/web-search-eval.py --only openalex
#
# ⚠ 本脚本从**本机**发起；CF 边缘可达性另见 worker 的 /app-api/lab/web-probe。
import argparse
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")

SEL = "select=id,display_name,publication_year,doi,type,cited_by_count"

# 5 个真实 9699 问题：中文提问（学生会这么问）+ 英文检索词（术语桥应产出的大致形态）
QUERIES = [
    {
        "id": "riots-family",
        "zh": "卡梅伦在 2011 年骚乱后说「家庭破裂」是原因，这个说法有研究支持吗？",
        "en": 'Cameron 2011 England riots "family breakdown" underclass',
        "short": "troubled families",
    },
    {
        "id": "lone-parent-edu",
        "zh": "单亲家庭的孩子教育成就是不是更差？有哪些研究？",
        "en": "lone parent family children educational attainment UK study",
        "short": "lone parent educational attainment",
    },
    {
        "id": "social-media-mh",
        "zh": "社交媒体使用和青少年心理健康到底有没有因果关系？",
        "en": "social media use adolescent mental health causal longitudinal evidence",
        "short": "social media adolescent mental health",
    },
    {
        "id": "cultural-capital",
        "zh": "布迪厄的文化资本理论在英国教育研究里是怎么被检验的？",
        "en": "Bourdieu cultural capital educational attainment UK longitudinal study",
        "short": "cultural capital educational attainment",
    },
    {
        "id": "domestic-labour",
        "zh": "女性承担家务更多，有近年的统计数据吗？",
        "en": "gender division of domestic labour time use survey UK statistics",
        "short": "domestic division of labour",
    },
]

# OpenAlex 的三种检索口径（A 是当前实现用的，B/C 是候选改进）
OA_VARIANTS = [
    ("A 全文 search=",
     lambda q: f"https://api.openalex.org/works?search={urllib.parse.quote(q['en'])}&per_page=5&{SEL}"),
    ("B 题摘 title_and_abstract.search",
     lambda q: "https://api.openalex.org/works?filter=title_and_abstract.search:"
               f"{urllib.parse.quote(q['en'])}&per_page=5&{SEL}"),
    ("C B+2012起+仅article+按被引",
     lambda q: "https://api.openalex.org/works?filter=title_and_abstract.search:"
               f"{urllib.parse.quote(q['en'])},from_publication_date:2012-01-01,type:article"
               f"&sort=cited_by_count:desc&per_page=5&{SEL}"),
]

# 第二轮：短关键词 + 结构化过滤（用来区分"B 口径不行"与"query 太长"）
OA_VARIANTS2 = [
    ("D 全文(长句)+仅article+2010起+被引",
     lambda q: "https://api.openalex.org/works?search=" + urllib.parse.quote(q["en"])
               + "&filter=type:article,from_publication_date:2010-01-01"
               + f"&sort=cited_by_count:desc&per_page=5&{SEL}"),
    ("E 题摘(短词 3-4 个)",
     lambda q: "https://api.openalex.org/works?filter=title_and_abstract.search:"
               + urllib.parse.quote(q["short"])
               + f"&per_page=5&{SEL}"),
    ("F 全文(短词)+仅article+被引",
     lambda q: "https://api.openalex.org/works?search=" + urllib.parse.quote(q["short"])
               + "&filter=type:article&sort=cited_by_count:desc"
               + f"&per_page=5&{SEL}"),
]

# 第三轮：验证推荐配方（题摘 + 短词 + 结构化过滤，**不按被引排序**）
OA_VARIANTS3 = [
    ("G 题摘(短词)+仅article+2000起",
     lambda q: "https://api.openalex.org/works?filter=title_and_abstract.search:"
               + urllib.parse.quote(q["short"])
               + ",type:article,from_publication_date:2000-01-01"
               + f"&per_page=5&{SEL}"),
    ("H 题摘(短词)+仅article+2015起",
     lambda q: "https://api.openalex.org/works?filter=title_and_abstract.search:"
               + urllib.parse.quote(q["short"])
               + ",type:article,from_publication_date:2015-01-01"
               + f"&per_page=5&{SEL}"),
]

# 明显的"非研究"条目（书的参考文献页 / 索引页），出现过一次就该被口径排除
JUNK = re.compile(r"^(references|index|front matter|back matter|contents|"
                  r"list of (tables|figures|contributors)|appendix|notes)\b", re.I)


def dev_var(name: str) -> str:
    f = ROOT / ".dev.vars"
    if not f.exists():
        return ""
    for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def http(method: str, url: str, payload=None, token: str = "", timeout: int = 45):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        **({"Content-Type": "application/json"} if data else {}),
        **({"Authorization": f"Bearer {token}"} if token else {}),
    })
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "ignore")), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")[:300], time.time() - t0
    except Exception as e:                                    # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}", time.time() - t0


def domain(url: str) -> str:
    try:
        return urllib.parse.urlparse(url).netloc.replace("www.", "")
    except Exception:                                         # noqa: BLE001
        return "?"


def run_tavily(queries, key: str, zh_probe: bool = True) -> None:
    print("\n" + "=" * 78)
    print("Tavily（现实案例侧）  basic depth / 5 条")
    print("=" * 78)
    if not key:
        print("跳过：没有 TAVILY_API_KEY")
        return
    total_credits = 0
    for q in queries:
        print(f"\n[{q['id']}] {q['zh']}")
        print(f"  en: {q['en']}")
        status, body, ms = http("POST", "https://api.tavily.com/search",
                                {"query": q["en"], "search_depth": "basic",
                                 "max_results": 5}, token=key)
        if status != 200 or not isinstance(body, dict):
            print(f"  FAIL HTTP {status}（{ms:.1f}s） {str(body)[:200]}")
            continue
        usage = body.get("usage") or {}
        total_credits += int(usage.get("credits") or 0)
        results = body.get("results") or []
        print(f"  OK {ms:.1f}s  {len(results)} 条  usage={usage or '—'}")
        for r in results:
            d = domain(r.get("url", ""))
            date = r.get("published_date") or ""
            sn = (r.get("content") or "").replace("\n", " ")[:90]
            print(f"   · [{d}] {date} {r.get('title', '')[:88]}")
            print(f"     {sn}")
    if zh_probe:
        q = queries[0]
        print(f"\n[语言对照] 中文原问直投 Tavily（看术语桥是否必需）")
        status, body, ms = http("POST", "https://api.tavily.com/search",
                                {"query": q["zh"], "search_depth": "basic",
                                 "max_results": 5}, token=key)
        if status == 200 and isinstance(body, dict):
            for r in (body.get("results") or [])[:5]:
                print(f"   · [{domain(r.get('url', ''))}] {r.get('title', '')[:88]}")
        else:
            print(f"   FAIL HTTP {status}")
    print(f"\nTavily 本轮估算消耗：{total_credits} credits")


def run_openalex(queries, key: str, variants=OA_VARIANTS) -> None:
    print("\n" + "=" * 78)
    print(f"OpenAlex（过往研究侧）  {len(variants)} 种口径对比 / 每种取 5 条")
    print("=" * 78)
    for q in queries:
        print(f"\n[{q['id']}] en: {q['en']}   |  short: {q['short']}")
        for label, build in variants:
            url = build(q) + (f"&api_key={key}" if key else "")
            status, body, ms = http("GET", url)
            if status != 200 or not isinstance(body, dict):
                print(f"  {label}: FAIL HTTP {status}（{ms:.1f}s） {str(body)[:160]}")
                continue
            meta = body.get("meta") or {}
            works = body.get("results") or []
            junk = [w for w in works if JUNK.match((w.get("display_name") or "").strip())]
            print(f"  {label}: 命中 {meta.get('count')} 篇 / {ms:.1f}s"
                  f"{'  ⚠ 含 %d 条非研究条目' % len(junk) if junk else ''}")
            for w in works[:3]:
                t = (w.get("display_name") or "")[:82]
                print(f"     - {t} ({w.get('publication_year')}) "
                      f"[{w.get('type')}, {w.get('cited_by_count')} cites]")
            time.sleep(0.25)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["tavily", "openalex"], default=None)
    ap.add_argument("--phase", type=int, default=1, choices=[1, 2, 3],
                    help="1=A/B/C（长句）；2=D/E/F（短词与过滤）；3=G/H（推荐配方验证）")
    ap.add_argument("--no-zh-probe", action="store_true")
    args = ap.parse_args()

    print(f"评估问题 {len(QUERIES)} 个，phase={args.phase}")
    if args.only in (None, "tavily") and args.phase == 1:
        run_tavily(QUERIES, dev_var("TAVILY_API_KEY"), not args.no_zh_probe)
    if args.only in (None, "openalex"):
        run_openalex(QUERIES, dev_var("OPENALEX_API_KEY"),
                     {1: OA_VARIANTS, 2: OA_VARIANTS2, 3: OA_VARIANTS3}[args.phase])
    print("\n注意：本脚本只测召回质量；出口可达性见 worker 的 /app-api/lab/web-probe")


if __name__ == "__main__":
    main()
