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
OR_URL = "https://openrouter.ai/api/v1/chat/completions"
OR_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
AG_URL = "https://apihub.agnes-ai.com/v1/chat/completions"
AG_MODEL = "agnes-2.5-flash"
# provider → (端点, 模型, key 变量名)。默认走 openrouter（免费池，不消耗魔搭额度）
PROVIDERS = {
    "openrouter": (OR_URL, OR_MODEL, "OPENROUTER_API_KEY"),
    "agnes": (AG_URL, AG_MODEL, "AGNES_API_KEY"),
    "ms": (MS_URL, MS_MODEL, "MODELSCOPE_API_KEY"),
}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")

SOURCES = {                                                # name → (权重, 显示名)
    "tb1": (1.1, "Haralambos 教材 Key terms"),
    "tb2": (1.1, "Livesey 教材 Key terms"),
    "igcse0495": (1.0, "0495/2251 官方 glossary"),
    "main": (0.8, "主站词库（校本手写）"),
}
STOP = {"the", "a", "an", "of", "and", "in", "for", "to", "on", "with", "by", "as", "is", "are"}

PROMPT = """你是剑桥 9699 A Level 社会学的阅卷官。下面同一个术语给了多份来源定义，请**按来源分别拆要素**，再选出一个「参考来源」作为判分基准。

术语：{term}

来源定义：
{defs}

要求：
1. 先为每个来源单独列出它自己定义里的要素（**不要跨来源合并**），每来源 1–4 条；
2. 选出一个「参考来源」作为判分必踩点，优先级：
   a) 优先选 main（学生日常练习所用，exposure 最高，判分应与所学口径一致）；
   b) 只有当 main 明显不完整或不准确时，才改选与 main 方向一致的权威来源（教材 tb1 > 官方 igcse0495），并在 reference_reason 里说明原因；
3. keypoints = 参考来源的那些要素（学生把这些答全即为满分，通常 2–4 条），每条注明 source；
4. bonus = 其他来源**独有**、而参考来源没有覆盖的要素（只作加分 / 可接受变体，不要求必答），注明 sources；
5. 来源 key 只能用：{keys}；
6. 严格只输出 JSON，不要解释、不要 markdown 代码块。

输出 JSON：
{{"reference":"main|tb1|igcse0495","reference_reason":"一句话说明为什么选它",
  "keypoints":[{{"text":"中文写的要素","source":"main"}}],
  "bonus":[{{"text":"中文写的要素","sources":["igcse0495"]}}],
  "source_notes":{{"main":"该来源要点一句话","tb1":"...","igcse0495":"..."}},
  "note":""}}"""


def load_key(var: str) -> str:
    for line in (ROOT / ".dev.vars").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(f"{var}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"no {var} in .dev.vars")


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


def call_llm(prompt: str, key: str, provider: str = "openrouter", max_tokens=1600,
             retries=3, verbose=True):
    url, model, _ = PROVIDERS[provider]
    body: dict = {"model": model, "messages": [{"role": "user", "content": prompt}],
                  "stream": False, "max_tokens": max_tokens, "temperature": 0.2}
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}", "User-Agent": UA}
    if provider == "openrouter":
        body["reasoning"] = {"enabled": False}     # nemotron 默认吐推理，关掉只留答案
        headers.update({"HTTP-Referer": "https://9699vocab.cn", "X-Title": "9699-skill"})
    elif provider == "ms":
        body["enable_thinking"] = False
    data = json.dumps(body).encode("utf-8")
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method="POST", headers=headers)
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
    ap.add_argument("--provider", default="openrouter", choices=sorted(PROVIDERS),
                    help="直连哪家：openrouter（免费池，默认）/ agnes（本地可用、Worker 出口被封）/ ms（烧魔粒）")
    args = ap.parse_args()

    _url, _model, _keyvar = PROVIDERS[args.provider]
    api_key = load_key(_keyvar)
    print(f"provider={args.provider}  model={_model}")
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
        txt = call_llm(prompt, api_key, provider=args.provider, max_tokens=args.max_tokens)
        if args.probe:
            print("\n=== RAW RESPONSE ===")
            print(txt)
        parsed = parse_json(txt) or {}
        rec = {"term": t["term"], "chinese": t["chinese"], "paper": t["paper"], "unit": t["unit"],
               "sources": {k: v[:400] for k, v in t["external"].items()} | {"main": t["main_def"][:400]},
               "reference": parsed.get("reference", ""),
               "reference_reason": parsed.get("reference_reason", ""),
               "keypoints": parsed.get("keypoints", []),
               "bonus": parsed.get("bonus", []),
               "source_notes": parsed.get("source_notes", {}),
               "note": parsed.get("note", ""),
               "raw": (txt or "")[:500],
               "parse_ok": bool(parsed.get("keypoints"))}
        results.append(rec)
        with jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"[{i}/{len(target)}] {t['term']}  -> ref={rec['reference'] or '?'} "
              f"keypoints={len(rec['keypoints'])} bonus={len(rec['bonus'])}"
              f"{' (parse failed)' if not rec['parse_ok'] else ''}")
        if args.probe:
            break
        time.sleep(args.sleep)

    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    ok = sum(1 for r in results if r["parse_ok"])
    print(f"\n完成 {len(results)} 条（解析成功 {ok}），写入 {out_path}")

    print("\n=== 抽检（参考来源 + 必踩点 + 加分点）===")
    for r in results[:30]:
        print(f"\n[{r['term']}]  ref={r.get('reference') or '?'}"
              f"  （{r.get('reference_reason','')[:60]}）")
        print(f"   主站定义: {r['sources'].get('main','')[:95]}")
        for n in ("tb1", "tb2", "igcse0495"):
            if r["sources"].get(n):
                print(f"   {n:9s}: {r['sources'][n][:95]}")
        for kp in r["keypoints"]:
            print(f"   ✓ 必踩 [{kp.get('source','?')}] {kp.get('text','')}")
        for b in r.get("bonus", []):
            print(f"   + 加分 [{','.join(b.get('sources', []))}] {b.get('text','')}")
        if r.get("note"):
            print(f"   note: {r['note'][:110]}")


if __name__ == "__main__":
    main()
