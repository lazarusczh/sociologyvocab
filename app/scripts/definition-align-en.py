"""给每个踩分要素配上它在权威来源英文原文里的对应表述（keypoints[].en）。

为什么需要：判分时要素只有中文（如「低工作保障」），学生却用英文作答（如 "low-security jobs"），
模型要做「英文 → 中文要素」的跨语言映射，还要再容错词序/构词变化，两层都不稳 ——
实测漏判：原文 "low job security"，学生写 "low-security jobs" 被判未覆盖。

做法：把「术语 + 各要素（中文）+ 各来源英文原文」给模型，让它为每个要素**摘出原文中对应的英文表述**
（只允许原文措辞或其最小改写，不得自创），存进 keypoints[].en。
以后判分提示词与前端要素对照都会同时显示中文要素与英文表述。

用法：
  python scripts/definition-align-en.py --limit 20                       # 试跑
  python scripts/definition-align-en.py --limit 700 --resume --concurrency 5
  python scripts/definition-align-en.py --provider agnes --resume --retry-failed   # 换通道补跑失败项
  python scripts/definition-align-en.py --apply                          # 合并回 definition-keypoints.json

通道：openrouter = nemotron-super-120b:free（免费额度约 1000/日，用满报 429）；
      agnes = agnes-2.5-flash（免费，本地直连可用；从 CF 出口会被 WAF 拒，故只用于本地脚本）。
"""
import argparse
import json
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POOL = ROOT / "data/definition-keypoints.json"
DEV_VARS = ROOT / ".dev.vars"

PROVIDERS = {
    "openrouter": ("https://openrouter.ai/api/v1/chat/completions",
                   "nvidia/nemotron-3-super-120b-a12b:free", "OPENROUTER_API_KEY"),
    "agnes": ("https://apihub.agnes-ai.com/v1/chat/completions",
              "agnes-2.5-flash", "AGNES_API_KEY"),
}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")

PROMPT = """下面是一个社会学术语的「踩分要素」（中文）与各权威来源的英文原文。
请为每个要素给出它在英文原文中**对应的英文表述**，用于判分对照。

要求：
1. **只能使用英文原文里出现过的措辞，或它的最小改写**；不得自创、不得引入原文没有的概念。
2. **每个要素只摘「它自己那一部分」**：不得夹带属于**其它要素**的内容。
   若两个要素在原文里由同一句表达，请**在该句内部切分出各自对应的片段**
   （按 and / 逗号 / therefore 等切分）。例如原文
   "believes men have less sympathy and are therefore more objective" 拆成两个要素时，
   前者摘 "believes men have less sympathy"，后者摘 "are therefore more objective"。
3. **必须尽量给出英文表述**；只有在原文确实完全没有涉及该要素时才填空字符串 ""。
4. 输出数量必须与要素数量一致、顺序一致。
5. 严格只输出 JSON，不要解释、不要 markdown。

术语：{term}

要素：
{items}

英文原文：
{defs}

只输出 JSON：
{{"en":["对应表述1","对应表述2"]}}"""


def load_key(var: str) -> str:
    for line in DEV_VARS.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(f"{var}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"no {var} in .dev.vars")


def call(prompt: str, url: str, model: str, key: str, max_tokens=700, retries=3):
    body = {"model": model, "messages": [{"role": "user", "content": prompt}],
            "stream": False, "max_tokens": max_tokens, "temperature": 0.1}
    if "openrouter" in url:
        body["reasoning"] = {"enabled": False}          # nemotron 默认吐推理过程，关掉只留答案
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}",
               "User-Agent": UA, "HTTP-Referer": "https://9699vocab.cn"}
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, method="POST", headers=headers)
            with urllib.request.urlopen(req, timeout=120) as r:
                payload = json.loads(r.read().decode())
            ch = payload.get("choices") or []
            if ch:
                return (ch[0].get("message") or {}).get("content", "")
        except urllib.error.HTTPError as e:
            print(f"    HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:110]}")
        except Exception as e:                                    # noqa: BLE001
            print(f"    ERR {type(e).__name__}: {e}")
        time.sleep(2 * (attempt + 1))
    return None


def parse(txt: str, n: int):
    if not txt:
        return None
    m = re.search(r"\{.*\}", txt, re.S)
    if not m:
        return None
    try:
        obj = json.loads(re.sub(r",\s*([}\]])", r"\1", m.group(0)))
    except json.JSONDecodeError:
        return None
    en = obj.get("en")
    if not isinstance(en, list):
        return None
    en = [str(x).strip() for x in en][:n]
    while len(en) < n:
        en.append("")
    return en


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--out", default="C:/Users/rebir/AppData/Local/Temp/keypoint-en.jsonl")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--sleep", type=float, default=0.0)
    ap.add_argument("--concurrency", type=int, default=4, help="并发请求数（免费档限流时调小）")
    ap.add_argument("--provider", default="openrouter", choices=sorted(PROVIDERS))
    ap.add_argument("--apply", action="store_true", help="把 jsonl 结果合并回 definition-keypoints.json")
    args = ap.parse_args()

    pool = json.loads(POOL.read_text(encoding="utf-8"))

    if args.apply:
        out = Path(args.out)
        if not out.exists():
            raise SystemExit(f"找不到 {out}")
        got = {}
        for line in out.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
                if rec.get("en"):
                    got[rec["term"]] = rec["en"]      # 后写覆盖先写（retry 成功的那次生效）
            except json.JSONDecodeError:
                pass
        n_kp = n_bonus = n_terms = 0
        for it in pool:
            en = got.get(it["term"])
            if not en:
                continue
            n_terms += 1
            for i, kp in enumerate(it.get("keypoints") or []):
                if i < len(en) and en[i]:
                    kp["en"] = en[i]
                    n_kp += 1
            base = len(it.get("keypoints") or [])
            for i, bp in enumerate(it.get("bonus") or []):
                idx = base + i
                if idx < len(en) and en[idx]:
                    bp["en"] = en[idx]
                    n_bonus += 1
        POOL.write_text(json.dumps(pool, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"已合并 {n_terms} 条术语：keypoints {n_kp} 个、bonus {n_bonus} 个要素带上英文表述 → {POOL}")
        return

    url, model, keyvar = PROVIDERS[args.provider]
    key = load_key(keyvar)
    print(f"provider={args.provider} model={model} concurrency={args.concurrency}")

    targets = [it for it in pool if it.get("keypoints")][: args.limit]
    out = Path(args.out)
    done = {}
    if args.resume and out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
                done[rec["term"]] = rec
            except json.JSONDecodeError:
                pass
        print(f"resume: 已写过 {len(done)} 条")
    todo = [it for it in targets
            if not (done.get(it["term"], {}).get("en")
                    and not (args.retry_failed and not done[it["term"]].get("en")))]

    def work(it):
        kps = list(it["keypoints"]) + list(it.get("bonus") or [])
        items = "\n".join(f"{j + 1}. {k['text']}" for j, k in enumerate(kps))
        defs = "\n".join(f"[{src}] {d}" for src, d in (it.get("source_defs") or {}).items()) or "（无英文原文）"
        txt = call(PROMPT.format(term=it["term"], items=items, defs=defs), url, model, key)
        return it, kps, parse(txt, len(kps))

    ok = 0
    with out.open("a", encoding="utf-8") as f, ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futures = [ex.submit(work, it) for it in todo]
        for n, fut in enumerate(as_completed(futures), 1):
            it, kps, en = fut.result()
            if en:
                ok += 1
            f.write(json.dumps({"term": it["term"], "en": en or []}, ensure_ascii=False) + "\n")
            f.flush()
            filled = sum(1 for x in (en or []) if x)
            print(f"[{n}/{len(todo)}] {it['term'][:34]:36s} 要素{len(kps)} → 命中英文 {filled}"
                  f"{'' if en else '  (failed)'}")
            if args.sleep:
                time.sleep(args.sleep)

    print(f"\n写入 {out}；本次成功 {ok} / {len(todo)}")


if __name__ == "__main__":
    main()
