# 定义题判分自测（服务于主站定义题，不涉及知识库子站）
#
# 目的：拿三来源互证的「踩分点」，检验 AI 判分（三档）是否稳定、档位是否合理。
# 样本不靠模型编造，而由真实语料构造：
#   full     = 权威来源的完整定义原文           （预期 correct）
#   partial  = 同一定义的第一个句子            （预期 partial）
#   wrong    = 同一 Paper 下另一个术语的定义    （预期 wrong）
# 这样"预期档位"是确定的，可直接算准确率与混淆矩阵。
#
# 用法：
#   python scripts/definition-grading-selftest.py --n 10                 # 默认 provider 自动选择
#   python scripts/definition-grading-selftest.py --n 10 --provider openrouter
#   python scripts/definition-grading-selftest.py --n 10 --repeat 3      # 每题重复判 3 次测一致性
import argparse
import json
import random
import re
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEYPOINTS = ROOT / "data/definition-keypoints.json"
KEYTERMS_DIR = ROOT / "data/ms-skill/keyterms"
VOCAB = ROOT / "public/vocab-data.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
PROVIDERS = {
    "ms": ("https://api-inference.modelscope.cn/v1/chat/completions", "Qwen/Qwen3-235B-A22B",
           "MODELSCOPE_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1/chat/completions",
                   "nvidia/nemotron-3-super-120b-a12b:free", "OPENROUTER_API_KEY"),
}
STOP = {"the", "a", "an", "of", "and", "in", "for", "to", "on", "with", "by", "as", "is", "are"}

PROMPT = """你是剑桥 9699 A Level 社会学的阅卷官。学生在做「术语定义默写」，请**只判定每个要素的覆盖程度**，不要给档位。

术语：{term}

核心要素（来自多个权威来源的共识，共 {n} 条）：
{keypoints}
{extra}
学生答案：{answer}

请对每个要素给出覆盖度 coverage：
- 1.0 = 该要素的意思表达到位（不要求用词一致、不要求逐点复述，意思到了即可）
- 0.5 = 只沾到一部分（说了半句、过于笼统、要靠猜才成立）
- 0.0 = 没提到，或说错

另外判断 listing_only：答案是否只是把关键词堆在一起、没有形成完整陈述（true/false）。
用中文或英文作答都算；意思相同即算覆盖，不要求用词一致。

只输出 JSON（不要 markdown、不要解释）：
{{"coverage":[1.0,0.0],"listing_only":false,"reason":"不超过40字的中文理由","confidence":0.0}}"""


def load_key(var: str):
    f = ROOT / ".dev.vars"
    if not f.exists():
        return None
    for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(f"{var}="):
            v = line.split("=", 1)[1].strip().strip('"').strip("'")
            return v or None
    return None


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


def call_llm(prompt: str, base: str, model: str, key: str, max_tokens=500, retries=3):
    body = {"model": model, "messages": [{"role": "user", "content": prompt}],
            "stream": False, "max_tokens": max_tokens, "temperature": 0.2,
            "enable_thinking": False}
    if "openrouter" in base:                              # nemotron 默认吐推理，需关掉
        body["reasoning"] = {"enabled": False}
    data = json.dumps(body).encode("utf-8")
    for attempt in range(retries):
        req = urllib.request.Request(base, data=data, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {key}", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                payload = json.loads(r.read().decode("utf-8"))
            return payload["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            print(f"    HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:150]}")
            time.sleep(3 * (attempt + 1))
        except Exception as e:                            # noqa: BLE001
            print(f"    ERR {type(e).__name__}: {e}")
            time.sleep(3 * (attempt + 1))
    return None


def parse_verdict(txt: str):
    if not txt:
        return None
    m = re.search(r"\{.*\}", txt, re.S)
    if not m:
        return None
    blob = re.sub(r"```.*$", "", m.group(0), flags=re.S)
    for cand in (blob, blob.rstrip().rstrip(",") + "}", blob[: blob.rfind("}") + 1]):
        try:
            obj = json.loads(re.sub(r",\s*([}\]])", r"\1", cand))
            if isinstance(obj, dict) and "coverage" in obj:
                return obj
        except json.JSONDecodeError:
            continue
    return None


def verdict_from_coverage(coverage: list, listing_only: bool) -> str:
    """档位由确定性规则算出（可复现、可审计）。用连续覆盖度，1 个要素的术语同样适用。"""
    try:
        vals = [float(x) for x in (coverage or [])]
    except (TypeError, ValueError):
        return "PARSE_FAIL"
    if not vals:
        return "wrong"
    score = sum(vals) / len(vals)
    if score >= 0.75 and not listing_only:
        return "correct"
    if score >= 0.35:
        return "partial"
    return "wrong"


def partial_excerpt(text: str) -> str:
    """只取一个分句，模拟"只答出一半"的学生答案（full 的子集，预期只覆盖 1 个要素）。"""
    parts = [p for p in re.split(r"(?<=[,;.])\s+", text.strip()) if p.strip()]
    return parts[0] if parts else text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10, help="抽多少个术语（每个术语 3 个样本）")
    ap.add_argument("--provider", default="auto", choices=["auto", "ms", "openrouter"])
    ap.add_argument("--repeat", type=int, default=1, help="同一答案重复判几次（测一致性）")
    ap.add_argument("--model", default="", help="覆盖默认模型 id")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--tier", default="high", choices=["high", "low", "all"],
                    help="只测高置信术语（core ≥2 个且多源互证），或全部")
    args = ap.parse_args()

    prov = args.provider
    if prov == "auto":
        prov = "openrouter" if load_key("OPENROUTER_API_KEY") else "ms"
    base, model, keyvar = PROVIDERS[prov]
    if args.model:
        model = args.model
    key = load_key(keyvar)
    if not key:
        raise SystemExit(f"{keyvar} 未在 app/.dev.vars 中配置；可先用 --provider ms（魔搭）跑通流程")
    print(f"provider={prov} model={model}")

    kps = json.loads(KEYPOINTS.read_text(encoding="utf-8"))
    if args.tier != "all":
        kps = [r for r in kps if r.get("tier", "high") == args.tier]
    print(f"候选术语（tier={args.tier}）：{len(kps)}")
    vocab = json.loads(VOCAB.read_text(encoding="utf-8"))
    items = vocab if isinstance(vocab, list) else (vocab.get("items") or [])
    main_def = {it.get("term"): it.get("definition", "") for it in items if it.get("type") == "term"}

    ext = {}
    for name in ("tb1", "tb2", "igcse0495"):
        p = KEYTERMS_DIR / f"{name}.json"
        if p.exists():
            ext[name] = [(toks(e.get("term")), (e.get("definition") or e.get("def") or ""))
                         for e in json.loads(p.read_text(encoding="utf-8"))]

    def ref_definition(term: str) -> str:
        """取该术语最完整的一条权威定义（tb1 > igcse0495 > 主站）——用于构造 full 样本。"""
        mt = toks(term)
        best = ""
        for name in ("tb1", "igcse0495", "tb2"):
            for st, d in ext.get(name, []):
                if not st:
                    continue
                inter, union = len(mt & st), len(mt | st)
                jac = (inter / union) if union else 0
                subset = ((mt <= st and len(mt) >= 2 and len(st) - len(mt) <= 1)
                          or (st <= mt and len(st) >= 2 and len(mt) - len(st) <= 1))
                if (jac >= 0.6 or subset) and len(d) > len(best):
                    best = d
        return best or main_def.get(term, "")

    # 分层抽样：按 unit 轮流取
    groups = defaultdict(list)
    for r in kps:
        u = r.get("unit")
        groups[(r.get("paper") or "", " / ".join(u) if isinstance(u, list) else (u or ""))].append(r)
    keys = sorted(groups)
    picked, i = [], 0
    while len(picked) < args.n and any(groups[k] for k in keys):
        k = keys[i % len(keys)]
        if groups[k]:
            picked.append(groups[k].pop(0))
        i += 1

    pool = [r for r in kps if r not in picked]
    samples = []
    for r in picked:
        ref = ref_definition(r["term"])
        if len(ref) < 20:
            continue
        wrong_ref = next((x for x in pool if x.get("paper") == r.get("paper")), None)
        wrong_def = ref_definition(wrong_ref["term"]) if wrong_ref else "This term is not defined here."
        samples.append((r, "full", ref, "correct"))
        samples.append((r, "partial", partial_excerpt(ref), "partial"))
        samples.append((r, "wrong", wrong_def[:300], "wrong"))

    print(f"术语 {len(picked)} 个 → 样本 {len(samples)} 个 × repeat {args.repeat}\n")
    results, correct_cnt = [], 0
    for idx, (rec, kind, ans, expect) in enumerate(samples, 1):
        # 判分清单：只取「教材 / 官方 glossary 支持」的核心要素 —— 它们是权威定义本身承载的要点。
        # 只被主站支持的单源要素降为加分项，避免拿"多源并集"当必踩点而误杀教材式答案。
        cores_all = [k for k in rec["keypoints"] if k.get("type") == "core"]
        cores = [k for k in cores_all
                 if set(k.get("sources", [])) & {"tb1", "tb2", "igcse0495"}] or cores_all
        kp_lines = "\n".join(f"{j+1}. {k.get('text')}" for j, k in enumerate(cores))
        vari = [v.get("text") for v in rec.get("variants", []) if v.get("text")]
        extra = f"可接受的其他表述：{'; '.join(vari)}\n\n" if vari else ""
        prompt = PROMPT.format(term=rec["term"], n=len(cores), keypoints=kp_lines,
                               extra=extra, answer=ans)
        verdicts, rec_coverage, rec_reason, rec_conf = [], [], "", ""
        for _ in range(args.repeat):
            v = parse_verdict(call_llm(prompt, base, model, key))
            if v:
                verdicts.append(verdict_from_coverage(v.get("coverage"), bool(v.get("listing_only"))))
                rec_reason = v.get("reason", "")
                rec_conf = v.get("confidence", "")
                rec_coverage = v.get("coverage", [])
            else:
                verdicts.append("PARSE_FAIL")
                rec_reason = rec_conf = ""
                rec_coverage = []
            time.sleep(2.0)                       # 魔搭有速率限制，间隔给足
        top = Counter(verdicts).most_common(1)[0][0]
        ok = top == expect
        correct_cnt += ok
        results.append({"term": rec["term"], "kind": kind, "expect": expect,
                        "verdicts": verdicts, "top": top, "ok": ok,
                        "reason": rec_reason, "confidence": rec_conf,
                        "coverage": rec_coverage,
                        "answer": ans[:200], "keypoints": [k.get("text") for k in rec["keypoints"]]})
        flag = "OK " if ok else "!! "
        print(f"[{idx}/{len(samples)}] {flag}{rec['term'][:30]:32s} {kind:7s} "
              f"expect={expect:7s} got={top:9s} {'/'.join(verdicts)}  {rec_reason[:40]}")

    n = len(results)
    print(f"\n=== 汇总（{n} 样本，严格一致 {correct_cnt}/{n} = {correct_cnt/n*100:.0f}%）===")
    for kind in ("full", "partial", "wrong"):
        sub = [r for r in results if r["kind"] == kind]
        hit = sum(r["ok"] for r in sub)
        print(f"  {kind:7s} 严格命中 {hit}/{len(sub)}  got={dict(Counter(r['top'] for r in sub))}")
    print("\n=== 关键指标（教学中真正要守住的）===")
    wn = [r for r in results if r["kind"] == "wrong"]
    fn = [r for r in results if r["kind"] == "full"]
    pn = [r for r in results if r["kind"] == "partial"]
    print(f"  防放水  wrong → wrong : {sum(r['top']=='wrong' for r in wn)}/{len(wn)}")
    print(f"  防误杀  full  → 非wrong: {sum(r['top']!='wrong' for r in fn)}/{len(fn)}")
    print(f"  档位精度 partial → partial: {sum(r['top']=='partial' for r in pn)}/{len(pn)}"
          f"（判 correct = 偏宽，可接受度低）")
    print(f"  误杀明细 full 判 wrong: {[r['term'] for r in fn if r['top']=='wrong']}")
    if args.repeat > 1:
        stable = sum(1 for r in results if len(set(r["verdicts"])) == 1)
        print(f"  一致性（{args.repeat} 次全同）：{stable}/{n}")

    out = Path("C:/Users/rebir/AppData/Local/Temp/grading-selftest.json")
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"明细写入 {out}")


if __name__ == "__main__":
    main()
