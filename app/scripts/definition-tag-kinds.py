# 逐要素标注性质：required（定义主干，必须答到）/ example（并列举例，举若干项即可）
#
# 为什么需要：靠"要素条数"判断列举型太粗。以 green crime 为例 ——
#   [定义主干] 一种危害环境的全球性犯罪        ← 必须答
#   [举例]     例如倾倒有毒废弃物 / 过度开采 / 污染  ← 举 1–2 项即可
# 该术语只有 4 条，但其中 3 条是举例；按条数放宽仍会要求学生多答。
#
# 用法（默认走 OpenRouter 免费池）：
#   python scripts/definition-tag-kinds.py --limit 400 --resume --out C:/tmp/kinds.jsonl
import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = {
    "openrouter": ("https://openrouter.ai/api/v1/chat/completions",
                   "nvidia/nemotron-3-super-120b-a12b:free", "OPENROUTER_API_KEY"),
    "agnes": ("https://apihub.agnes-ai.com/v1/chat/completions", "agnes-2.5-flash", "AGNES_API_KEY"),
}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
SRC = ROOT / "data/definition-keypoints.json"

PROMPT = """下面是术语「{term}」的必踩要素。请逐条判断它的性质：

A = 定义主干：概念本身的核心含义或机制。答题时不答这个就不算掌握该概念。
B = 并列举例：属于"例如 / 包括 / 具体类型"式的举例，学生举出其中若干项即可，不要求列全。

判断要点：
- 定义主干通常回答"是什么 / 通过什么机制"，去掉它概念就不成立 → A；
- 举例只是"具体形式之一"，去掉它概念仍然成立 → B。

要素：
{items}

只输出 JSON（不要 markdown、不要解释）：
{{"kinds":["A","B"],"note":""}}"""


def load_key(var: str) -> str:
    for line in (ROOT / ".dev.vars").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(f"{var}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"no {var} in .dev.vars")


def call(prompt: str, url: str, model: str, key: str, max_tokens=400, retries=3):
    body = {"model": model, "messages": [{"role": "user", "content": prompt}],
            "stream": False, "max_tokens": max_tokens, "temperature": 0.1,
            "reasoning": {"enabled": False}}
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}",
               "User-Agent": UA, "HTTP-Referer": "https://9699vocab.cn"}
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, method="POST", headers=headers)
            with urllib.request.urlopen(req, timeout=120) as r:
                payload = json.loads(r.read().decode())
            choices = payload.get("choices") or []
            if not choices:
                time.sleep(2 * (attempt + 1))
                continue
            return (choices[0].get("message") or {}).get("content", "")
        except urllib.error.HTTPError as e:
            print(f"    HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:110]}")
            time.sleep(2 * (attempt + 1))
        except Exception as e:                                     # noqa: BLE001
            print(f"    ERR {type(e).__name__}: {e}")
            time.sleep(2 * (attempt + 1))
    return None


def parse(txt: str):
    if not txt:
        return None
    m = re.search(r"\{.*\}", txt, re.S)
    if not m:
        return None
    try:
        obj = json.loads(re.sub(r",\s*([}\]])", r"\1", m.group(0)))
        return obj.get("kinds") if isinstance(obj.get("kinds"), list) else None
    except json.JSONDecodeError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--provider", default="openrouter", choices=sorted(PROVIDERS))
    ap.add_argument("--out", default="C:/Users/rebir/AppData/Local/Temp/kinds.jsonl")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--min-kp", type=int, default=2, help="只处理要素数 ≥ 该值的术语（1 条无需分组）")
    ap.add_argument("--sleep", type=float, default=1.0)
    args = ap.parse_args()

    url, model, keyvar = PROVIDERS[args.provider]
    key = load_key(keyvar)
    print(f"provider={args.provider} model={model}")

    items = json.loads(SRC.read_text(encoding="utf-8"))
    targets = [r for r in items if len(r.get("keypoints", [])) >= args.min_kp]
    print(f"总术语 {len(items)}，需标注（要素 ≥{args.min_kp}）= {len(targets)}")

    out = Path(args.out)
    done = {}
    if args.resume and out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
                done[rec["term"]] = rec
            except json.JSONDecodeError:
                pass
        print(f"resume: {len(done)} 条已完成")

    ok = 0
    for i, r in enumerate(targets[: args.limit], 1):
        prev = done.get(r["term"])
        if prev and not (args.retry_failed and not prev.get("kinds")):
            continue
        lines = "\n".join(f"{j + 1}. {k['text']}" for j, k in enumerate(r["keypoints"]))
        txt = call(PROMPT.format(term=r["term"], items=lines), url, model, key)
        kinds = parse(txt)
        if kinds:
            kinds = [("example" if str(k).strip().upper().startswith("B") else "required") for k in kinds]
            # 长度对齐：模型少给时按 required 补齐
            while len(kinds) < len(r["keypoints"]):
                kinds.append("required")
            kinds = kinds[: len(r["keypoints"])]
            ok += 1
        else:
            kinds = []
        rec = {"term": r["term"], "kinds": kinds}
        done[r["term"]] = rec
        with out.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        nreq = kinds.count("required")
        print(f"[{i}/{min(args.limit, len(targets))}] {r['term'][:36]:38s} "
              f"required={nreq} example={len(kinds) - nreq}"
              f"{' (failed)' if not kinds else ''}")
        time.sleep(args.sleep)

    allk = {}
    for line in out.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
            allk[rec["term"]] = rec["kinds"]
        except json.JSONDecodeError:
            pass
    n_both = sum(1 for v in allk.values() if v and "required" in v and "example" in v)
    n_all_req = sum(1 for v in allk.values() if v and "example" not in v)
    n_all_ex = sum(1 for v in allk.values() if v and "required" not in v)
    print(f"\n已标注 {len(allk)} 条：全 required={n_all_req}，含举例={n_both}，全举例={n_all_ex}")


if __name__ == "__main__":
    main()
