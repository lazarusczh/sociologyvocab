# 用「推荐配方」跑单个问题（对应 知识库联网查询方案.md §5.5），供人工审阅联网论据质量
#
# 与另两个脚本的分工：
#   web-search-probe.py  → 可达性 / key / 返回结构
#   web-search-eval.py   → 口径横向对比（批量、固定 5 题）
#   web-search-sample.py → 单个真实问题，按**已定型配方**取一轮结果（≈ 产品里第二段会拿到什么）
#
# 用法：
#   python app/scripts/web-search-sample.py \
#       --en "is marriage no longer important UK cohabitation decline statistics" \
#       --short "marriage decline cohabitation"
#
# ⚠ 本脚本**不抓正文**（对应方案 §10-2 的建议：v1 只给标题+链接+摘要）。
import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")

SEL = "select=id,display_name,publication_year,doi,type,cited_by_count,primary_location"

# §5.5 ⑤ 的域名黑名单：论文代写站一类的"形似学术、实为垃圾"的源
BLOCK = ("ukessays.com", "essaypro", "studocu", "coursehero", "gradesfixer",
         "bartleby", "ipl.org", "123helpme", "papersowl")


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


def host(url: str) -> str:
    try:
        return urllib.parse.urlparse(url).netloc.replace("www.", "")
    except Exception:                                         # noqa: BLE001
        return "?"


def tavily(query: str, n: int) -> None:
    key = dev_var("TAVILY_API_KEY")
    print(f"\n## Tavily（现实案例侧）  query: `{query}`\n")
    if not key:
        print("（无 TAVILY_API_KEY，跳过）")
        return
    status, body, ms = http("POST", "https://api.tavily.com/search",
                            {"query": query, "search_depth": "basic",
                             "max_results": n}, token=key)
    if status != 200 or not isinstance(body, dict):
        print(f"FAIL HTTP {status}（{ms:.1f}s） {str(body)[:200]}")
        return
    print(f"{ms:.1f}s，{len(body.get('results') or [])} 条\n")
    for i, r in enumerate(body.get("results") or [], 1):
        d = host(r.get("url", ""))
        flag = "  ⛔ 黑名单" if any(b in d for b in BLOCK) else ""
        print(f"{i}. **{r.get('title', '')}**  ")
        print(f"   `{d}`{flag}  ")
        print(f"   {r.get('url', '')}  ")
        sn = (r.get("content") or "").replace("\n", " ")[:260]
        print(f"   > {sn}\n")
        time.sleep(0.05)


def openalex(short: str, n: int) -> None:
    key = dev_var("OPENALEX_API_KEY")
    print(f"\n## OpenAlex（过往研究侧）  短词: `{short}`\n")
    url = ("https://api.openalex.org/works?filter=title_and_abstract.search:"
           + urllib.parse.quote(short)
           + ",type:article&per_page=" + str(n) + "&" + SEL
           + (f"&api_key={key}" if key else ""))
    status, body, ms = http("GET", url)
    if status != 200 or not isinstance(body, dict):
        print(f"FAIL HTTP {status}（{ms:.1f}s） {str(body)[:200]}")
        return
    meta = body.get("meta") or {}
    print(f"{ms:.1f}s，命中 {meta.get('count')} 篇\n")
    for i, w in enumerate((body.get("results") or [])[:n], 1):
        pl = w.get("primary_location") or {}
        src = ((pl.get("source") or {}) or {}).get("display_name") or ""
        print(f"{i}. **{w.get('display_name')}**  ")
        print(f"   {w.get('publication_year')} · {src or '—'} · "
              f"{w.get('cited_by_count')} cites · [{w.get('type')}]  ")
        print(f"   {w.get('doi') or w.get('id')}\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--en", required=True, help="给 Tavily 的自然语言长句（含国别/时间限定）")
    ap.add_argument("--short", required=True, help="给 OpenAlex 的 2-4 个关键词")
    ap.add_argument("--n", type=int, default=5)
    args = ap.parse_args()
    tavily(args.en, args.n)
    openalex(args.short, args.n)


if __name__ == "__main__":
    main()
