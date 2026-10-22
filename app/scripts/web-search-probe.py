# 联网检索源探针（本机）：验证 Tavily / OpenAlex 的 key 与返回结构
#
# ⚠ **本脚本不测 CF 出口可达性**：它从本机发起，而"本机通 ≠ Cloudflare 边缘通"
#   （本项目已两次踩坑：Agnes 国际站 1015、非浏览器 UA 被 1010）。
#   出口可达性请用 worker 的 `/app-api/lab/web-probe`（从边缘真实发起）。
#
# 用法：
#   python scripts/web-search-probe.py                             # tavily basic，默认查询
#   python scripts/web-search-probe.py --provider openalex
#   python scripts/web-search-probe.py --query "..." --depth advanced --max-results 5
import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

DEFAULT_QUERY = 'Cameron 2011 riots "family breakdown" speech'

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")


def dev_var(name: str) -> str:
    f = ROOT / ".dev.vars"
    if not f.exists():
        return ""
    for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def http(method: str, url: str, payload=None, token: str = "", timeout: int = 45):
    """返回 (status, body, 耗时秒, 响应头)。status=0 表示网络层失败（超时/DNS/TLS）。"""
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
            return r.status, json.loads(r.read().decode("utf-8", "ignore")), time.time() - t0, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")[:400], time.time() - t0, dict(e.headers or {})
    except Exception as e:                                    # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}", time.time() - t0, {}


def probe_tavily(query: str, depth: str, max_results: int) -> None:
    key = dev_var("TAVILY_API_KEY")
    if not key:
        print("【Tavily】跳过：app/.dev.vars 里没有 TAVILY_API_KEY")
        return
    print(f"【Tavily】key 已找到（长度 {len(key)}，不打印），depth={depth}")
    status, body, ms, _ = http("POST", "https://api.tavily.com/search",
                               {"query": query, "search_depth": depth,
                                "max_results": max_results}, token=key)
    if status != 200 or not isinstance(body, dict):
        print(f"  FAIL HTTP {status}（{ms:.1f}s）  {str(body)[:300]}")
        if status == 0:
            print("  提示：网络层失败（TLS/超时）。本机若需代理，先设置环境变量 HTTPS_PROXY 再重跑。")
        return
    results = body.get("results") or []
    print(f"  OK HTTP 200（{ms:.1f}s）  结果 {len(results)} 条  keys={sorted(body.keys())}")
    # credit 消耗：官方口径 basic search = 1 credit / advanced = 2 credits
    print(f"  usage={body.get('usage')}   ← credit 消耗看这里")
    for r in results[:3]:
        print(f"   - {r.get('title')}")
        print(f"     {r.get('url')}")
        sn = (r.get("content") or "").replace("\n", " ")[:140]
        if sn:
            print(f"     {sn}…")


def probe_openalex(query: str) -> None:
    key = dev_var("OPENALEX_API_KEY")
    print(f"【OpenAlex】{'带 key' if key else '无 key（免费档 10 req/s）'}")
    url = ("https://api.openalex.org/works?search=" + urllib.parse.quote(query)
           + "&per_page=2&select=id,display_name,publication_year,doi")
    status, body, ms, headers = http("GET", url, token=key)
    if status != 200 or not isinstance(body, dict):
        print(f"  FAIL HTTP {status}（{ms:.1f}s）  {str(body)[:300]}")
        return
    works = body.get("results") or []
    print(f"  OK HTTP 200（{ms:.1f}s）  命中 {body.get('meta', {}).get('count')} 篇，取回 {len(works)} 条")
    # 每日预算/剩余：官方建议用这些响应头监控
    for h in ("X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Used"):
        if headers.get(h) is not None:
            print(f"  {h}: {headers.get(h)}")
    for w in works:
        print(f"   - {w.get('display_name')}  ({w.get('publication_year')})")
        print(f"     {w.get('doi') or w.get('id')}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="tavily", choices=["tavily", "openalex"])
    ap.add_argument("--query", default=DEFAULT_QUERY)
    ap.add_argument("--depth", default="basic", choices=["basic", "advanced"])
    ap.add_argument("--max-results", type=int, default=3)
    args = ap.parse_args()

    print(f"查询：{args.query}\n")
    if args.provider == "tavily":
        probe_tavily(args.query, args.depth, args.max_results)
    else:
        probe_openalex(args.query)
    print("\n注意：本脚本不测出口可达性 —— 请用 worker 的 /app-api/lab/web-probe（本机通 != CF 边缘通）")


if __name__ == "__main__":
    main()
