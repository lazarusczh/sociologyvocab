# 多来源定义 → 「踩分要素（keypoints）」自动归纳
#
# 对应《定义题方案.md》第十节的 Step 2–4：
#   Step 2 单源要素切分 + Step 3 跨源要素合并 + Step 4 排序定档，
#   由一次 LLM 调用完成（把多份来源定义一起给出，要求合并同义要素并加权排序）。
#
# 来源与权重（见方案 10.2）：
#   tb1 教材 Key terms       w=1.1   （9699 考纲同级、节级粒度）
#   igcse0495 官方 glossary  w=1.0   （官方，但层级偏 IGCSE）
#   tb2 教材 Key terms       w=1.1   （条目少）
#   main 主站词库            w=0.8   （学生 exposure 最高，校本手写）
#
# 用法：
#   python scripts/skill-keypoints.py --probe                # 只跑 1 条，打印原始返回
#   python scripts/skill-keypoints.py --limit 25 --out C:/tmp/keypoints.json
#   python scripts/skill-keypoints.py --limit 25 --resume    # 断点续跑（读同名 .jsonl）
import argparse
import json
import re
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]                 # app/
MS_URL = "https://api-inference.modelscope.cn/v1/chat/completions"
MS_MODEL = "Qwen/Qwen3-235B-A22B"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")

SOURCES = {                                                # name → (权重, 显示名)
    "tb1": (1.1, "Haralambos 教材 Key terms"),
    "tb2": (1.1, "Livesey 教材 Key terms"),
    "igcse0495": (1.0, "0495/2251 官方 glossary"),
    "main": (0.8, "主站词库（校本手写）"),
}
STOP = {"the", "a", "an", "of", "and", "in", "for", "to", "on", "with", "by", "as", "is", "are"}

PROMPT = """你是剑桥 9699 A Level 社会学的阅卷官。下面给出同一个术语的多份权威定义，请归纳成可独立得分的「踩分要素」。

规则：
1. 一个要素 = 一个能独立给分的意思单元（不是词语复制，也不要罗列同义词）；
2. 多份定义表达同一意思时合并为一个要素，并列出支持它的来源 key；
3. 排序依据：来源权重之和（加权票）与支持广度（有几个来源强调）；
4. 只输出 2–4 个核心要素 core（定义确实简单时可以 1–2 个）；
5. 仅出现在单一来源、或过于细碎的点，放入 variants（不计分）；
6. sources 只能使用下列来源 key，不得编造：{keys}；
7. 严格只输出 JSON，不要解释、不要 markdown 代码块。

术语：{term}

来源定义（括号内为权重）：
{defs}

输出 JSON（sources 用 key：main / tb1 / tb2 / igcse0495）：
{{"term":"{term}","keypoints":[{{"text":"用中文写的要素","type":"core","sources":["main","tb1"],"breadth":2}}],"variants":[{{"text":"","sources":[]}}],"note":""}}"""


def load_key() -> str:
    for line in (ROOT / ".dev.vars").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("MODELSCOPE_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no MODELSCOPE_API_KEY in .dev.vars")


def stem(w: str) -> str:
    w = w.replace("-", "")
    for suf, rep in (("ies", "y"), ("sses", "ss"), ("es", ""), ("s", "")):
        if w.endswith(suf) and len(w) > len(suf) + 3:
            return w[: -len(suf)] + rep
    return w


def toks(s: str):
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"\([^)]*\)", " ", s)
    return {stem(w) for w in re.findall(r"[a-z][a-z\-]{2,}", s) if w not in STOP}


def call_llm(prompt: str, key: str, max_tokens=1600, retries=3, verbose=True):
    body = {"model": MS_MODEL, "messages": [{"role": "user", "content": prompt}],
            "stream": False, "max_tokens": max_tokens, "temperature": 0.2,
            "enable_thinking": False}
    data = json.dumps(body).encode("utf-8")
    for attempt in range(retries):
        req = urllib.request.Request(MS_URL, data=data, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {key}", "User-Agent": UA})
        if verbose and attempt == 0:
            print("  DEBUG headers:", {k: repr(v)[:50] for k, v in req.headers.items()})
            print("  DEBUG data:", type(data).__name__, len(data), "selector:", repr(req.selector))
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                payload = json.loads(r.read().decode("utf-8"))
            return payload["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            snippet = e.read().decode("utf-8", "ignore")[:200]
            if verbose:
                print(f"  HTTP {e.code}: {snippet}")
            time.sleep(3 * (attempt + 1))
        except Exception as e:                              # noqa: BLE001
            if verbose:
                print(f"  ERR {type(e).__name__}: {e}")
                traceback.print_exc()
            time.sleep(3 * (attempt + 1))
    return None


def parse_json(txt: str):
    """容错解析：模型可能包 ``` 、带尾随逗号、或被 max_tokens 截断（JSON 未闭合）。"""
    if not txt:
        return None
    m = re.search(r"\{.*", txt, re.S)
    if not m:
        return None
    blob = re.sub(r"```.*$", "", m.group(0), flags=re.S).strip()
    clean = lambda s: re.sub(r",\s*([}\]])", r"\1", s)      # 去尾随逗号
    candidates = [blob, blob.rstrip().rstrip(",") + "]}", blob.rstrip().rstrip(",") + "]}}"]
    idx = blob.rfind("}")
    if idx > 0:
        candidates.append(blob[: idx + 1])
    for cand in candidates:
        try:
            obj = json.loads(clean(cand))
            if isinstance(obj, dict) and obj.get("keypoints"):
                return obj
        except json.JSONDecodeError:
            continue
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--out", default="C:/Users/rebir/AppData/Local/Temp/keypoints.json")
    ap.add_argument("--sources-dir", default=str(ROOT / "data/ms-skill/keyterms"))
    ap.add_argument("--min-external", type=int, default=2, help="A 组门槛：至少几个外部来源")
    ap.add_argument("--sleep", type=float, default=1.2)
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--stratify", action="store_true",
                    help="按 paper/unit 分层轮流抽样，避免样本全落在一个单元")
    ap.add_argument("--retry-failed", action="store_true", help="重跑上次解析失败的条目")
    ap.add_argument("--max-tokens", type=int, default=1600)
    args = ap.parse_args()

    api_key = load_key()
    vocab = json.loads((ROOT / "public/vocab-data.json").read_text(encoding="utf-8"))
    items = vocab if isinstance(vocab, list) else (vocab.get("items") or [])
    main_terms = [it for it in items if it.get("type") == "term"]

    ext = {}
    for name in ("tb1", "tb2", "igcse0495"):
        p = Path(args.sources_dir) / f"{name}.json"
        if p.exists():
            ext[name] = json.loads(p.read_text(encoding="utf-8"))
    ext_toks = {n: [(toks(e.get("term", "")), e) for e in es] for n, es in ext.items()}

    # 对齐（词干 + 词集包含）：为主站每个术语找外部来源定义
    picked = []
    for it in main_terms:
        mt = toks(it.get("term", ""))
        if not mt:
            continue
        found = {}
        for n, lst in ext_toks.items():
            for st, e in lst:
                if not st:
                    continue
                inter, union = len(mt & st), len(mt | st)
                jac = (inter / union) if union else 0.0
                # 对齐：Jaccard 够高，或单侧包含「较短方 ≥2 词且词数差 ≤1」。
                # 后者放宽了复数/定语差异（Agency ↔ Agencies of socialisation），
                # 同时挡住 "Brain power" 被单条泛词 "Power" 命中的错配。
                subset = ((mt <= st and len(mt) >= 2 and len(st) - len(mt) <= 1)
                          or (st <= mt and len(st) >= 2 and len(mt) - len(st) <= 1))
                if jac >= 0.6 or subset:
                    d = (e.get("definition") or e.get("def") or "").strip()
                    if len(d) >= 12:                        # 定义缺失/过短的来源不算数
                        found[n] = d
                    break
        if len(found) >= args.min_external:
            picked.append({"term": it.get("term", ""), "chinese": it.get("chinese", ""),
                           "paper": it.get("paper", ""), "unit": it.get("unit", ""),
                           "main_def": it.get("definition", ""), "external": found})
    print(f"主站术语 {len(main_terms)}，A 组（外部来源 >= {args.min_external}）= {len(picked)}")

    if args.stratify:
        groups = {}
        for p in picked:
            u = p.get("unit")
            gkey = (p.get("paper") or "", tuple(u) if isinstance(u, list) else (u or ""),)
            groups.setdefault(gkey, []).append(p)
        gkeys = sorted(groups)
        target, i = [], 0
        while len(target) < args.limit and any(groups[gk] for gk in gkeys):
            gk = gkeys[i % len(gkeys)]
            if groups[gk]:
                target.append(groups[gk].pop(0))
            i += 1
    else:
        target = picked[:args.limit]
    if args.probe:
        target = target[:1]

    out_path = Path(args.out)
    jsonl = out_path.with_suffix(".jsonl")
    done = {}
    if args.resume and jsonl.exists():
        for line in jsonl.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
                done[rec["term"]] = rec
            except json.JSONDecodeError:
                pass
        print(f"resume: {len(done)} 条已完成")

    results = list(done.values())
    for i, t in enumerate(target, 1):
        prev = done.get(t["term"])
        if prev and not (args.retry_failed and not prev.get("parse_ok")):
            continue
        defs = [f"- {SOURCES['main'][1]}（w={SOURCES['main'][0]}）：{t['main_def']}"]
        for n, d in t["external"].items():
            w, label = SOURCES[n]
            defs.append(f"- {label}（w={w}）：{re.sub(r'\s+', ' ', d)}")
        usable = ["main", *t["external"].keys()]
        prompt = PROMPT.format(term=t["term"], defs="\n".join(defs), keys=", ".join(usable))
        if args.probe:
            print("\n=== PROMPT ===")
            print(prompt[:1500])
        txt = call_llm(prompt, api_key, max_tokens=args.max_tokens)
        if args.probe:
            print("\n=== RAW RESPONSE ===")
            print(txt)
        parsed = parse_json(txt)
        rec = {"term": t["term"], "chinese": t["chinese"], "paper": t["paper"], "unit": t["unit"],
               "sources": {k: v[:400] for k, v in t["external"].items()} | {"main": t["main_def"][:400]},
               "keypoints": (parsed or {}).get("keypoints", []),
               "variants": (parsed or {}).get("variants", []),
               "note": (parsed or {}).get("note", ""),
               "raw": (txt or "")[:500],
               "parse_ok": parsed is not None}
        results.append(rec)
        with jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        kps = rec["keypoints"]
        print(f"[{i}/{len(target)}] {t['term']}  -> {len(kps)} core"
              f"{' (parse failed)' if parsed is None else ''}")
        if args.probe:
            break
        time.sleep(args.sleep)

    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    ok = sum(1 for r in results if r["parse_ok"])
    print(f"\n完成 {len(results)} 条（解析成功 {ok}），写入 {out_path}")

    print("\n=== 抽检（每条 2–4 个踩分要素）===")
    for r in results[:30]:
        print(f"\n[{r['term']}]  ({r.get('paper','')} {r.get('unit','')})")
        print(f"   主站定义: {r['sources'].get('main','')[:90]}")
        for n in ("tb1", "tb2", "igcse0495"):
            if n in r["sources"]:
                print(f"   {n:9s}: {r['sources'][n][:90]}")
        for kp in r["keypoints"]:
            print(f"   ● [{kp.get('type','')}] {kp.get('text','')}"
                  f"   <- {','.join(kp.get('sources', []))} (breadth={kp.get('breadth','')})")
        if r["note"]:
            print(f"   note: {r['note'][:110]}")


if __name__ == "__main__":
    main()
