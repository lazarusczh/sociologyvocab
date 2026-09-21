"""多要素判分实验台（贴近线上条件）：真实条目 + 线上同款 prompt。

背景：单要素实验（definition-grading-lab.py）里 nemotron 关推理三轮全 16/16，
但线上仍出现漏判（要素「低工作保障」← 学生写 "low-security jobs" 被判未覆盖）。
差别在**要素数量与 prompt 规模**：线上是 4~5 个要素 + ★/· 标注 + 各来源英文原文 + 大段规则（~1500 字），
而这可能诱发模型「逐条打勾」的核对模式 —— 单要素实验里没有这个土壤。

本脚本：
  1. 从 definition-keypoints.json 取真实术语（要素数 ≥ --min-kp、且要素带英文表述）；
  2. 用 LLM 生成**学生风格的改写作答**（覆盖全部要素，但明确要求不照抄原文措辞）；
  3. 用四种判分形态跑同一份作答，比较**要素级误杀率**（作答保证全对，任何 <0.75 都是误杀）：
       M0 线上现状 prompt
       M1 现状 + 强化「逐要素独立判断、别因表述不同判未覆盖」
       M2 先重述学生答案、再逐要素判断
       M3 拆分：每个要素单独调用（成本 ×N，作为精度上限参考）

用法：
  python scripts/definition-grading-lab-multi.py --n 4 --provider openrouter
  python scripts/definition-grading-lab-multi.py --n 4 --variants M0,M2 --split
"""
import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POOL = ROOT / "data/definition-keypoints.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
PROVIDERS = {
    "openrouter": ("https://openrouter.ai/api/v1/chat/completions",
                   "nvidia/nemotron-3-super-120b-a12b:free", "OPENROUTER_API_KEY"),
    "ms": ("https://api-inference.modelscope.cn/v1/chat/completions",
           "Qwen/Qwen3.5-122B-A10B", "MODELSCOPE_API_KEY"),
}

# ---- 生成「学生风格改写作答」用的提示词 ----
GEN = """下面是术语「{term}」的答题要点（中文）与权威来源的英文原文。
请**模仿一名 A Level 学生**写一段术语定义作答，要求：
1. 必须覆盖下列**每一条**要点；
2. **不要照抄**任何原文措辞 —— 用你自己的话表达（同义替换、句序调整、复合词化、主被动转换都可以）；
3. 写成连贯的一两句，不要分点罗列、不要写小标题；
4. 只输出这段作答本身，不要解释、不要加引号。

术语：{term}
要点：
{items}

英文原文（仅供理解，不要照抄）：
{defs}"""

GEN_STYLES = ["简洁直接，像一个赶时间的学生。", "口语化一点，像是在口头解释。",
              "稍学术一些，但仍是学生自己的措辞。"]

# ---- 判分 prompt 变体（M0 与线上 app/src/lib/ai.ts 保持一致）----
BASE_RULES = """请对每个要素给出覆盖度 coverage：
- ★ 主干要素：1.0 = 表达到位；0.5 = 只沾到一部分（说了半句、过于笼统）；0.0 = 没提到或说错
- · 举例要素：**只给 0.0 或 1.0 两档**（明确举出了这个例子 → 1.0；没提到或只是笼统说"有危害/有多种形式" → 0.0）

另外判断 listing_only（"是否只是罗列关键词"）：
- true 仅指**把关键词成串堆在一起、完全没有形成句子**；
- 只要答案有主谓结构，即使中间夹着举例，也算**正常陈述 → false**。"""

M0 = """你是剑桥 9699 A Level 社会学的阅卷官。学生在做「术语定义默写」，请**只判定每个要素的覆盖程度**，不要给档位。

术语：{term}

参考原文（英文，来自权威来源，供你判断语义等价用）：
{defs}

核心要素（★ = 定义主干，必须答到；· = 并列举例，举出其中若干项即可）：
{items}

学生答案：{answer}

""" + BASE_RULES + """

判定口径（务必严格执行）：
- 用中文或英文作答都算；**只要与「核心要素」或「参考原文」意思相同即算覆盖**，不要求用词一致、更不要求复述原文；
- **同义改写必须宽容**：词序调整、复合词化、词性转换、单复数/时态变化、同义替换都算覆盖；
- **0.5 的边界**：只有「方向或程度明显不对」或「只说了半句、要靠猜才成立」才给 0.5；
  学生答出了要素的实质、只是少列了其中一个并列子点，应给 1.0；
- 0.0 仅当学生**完全没有表达该含义**（含说反了）。

只输出 JSON（不要 markdown、不要解释）：
{{"coverage":[{zeros}],"listing_only":false,"reason":"不超过40字的中文理由"}}"""

M1 = M0.replace(
    "判定口径（务必严格执行）：",
    """判定口径（务必严格执行）：
- **逐要素独立判断**：对每个要素单独问一句「学生这段话里有没有表达这个含义？」，
  **不要**把要素反过来拆成更细的检查点逐项对表（例如要素写「因长期失业和养家角色逆转而被边缘化」，
  学生只要表达了「被边缘化 + 失去养家角色」就算 1.0，不必逐字凑齐"长期失业"）；
- **先理解后判断**：先读懂学生这段话在说什么，再对照要素，而不是先在学生答案里搜关键词；""")

M2 = """你是剑桥 9699 A Level 社会学的阅卷官。学生在做「术语定义默写」。请分两步作答。

术语：{term}

参考原文（英文，来自权威来源）：
{defs}

核心要素（★ = 定义主干，必须答到；· = 并列举例）：
{items}

学生答案：{answer}

第一步：用 2~4 条列出**学生这段话表达了哪些含义**（只描述学生说了什么，不加评价、不补充学生没说过的内容；
       用学生自己的表达来概括，不要改写成要素的措辞）。
第二步：把第一步的清单与核心要素逐条对照，给出 coverage。

""" + BASE_RULES + """

判定口径：意思相同即算覆盖（词序、构词、词性、单复数、同义替换都算）；
0.5 只用于「方向或程度明显不对」或「只说了半句」；0.0 仅当**完全没有表达该含义**。

只输出 JSON（不要 markdown、不要解释）：
{{"restate":["学生表达的含义1","含义2"],"coverage":[{zeros}],"listing_only":false,"reason":"不超过40字"}}"""

# M4 = 候选上线版：先重述学生答案 + 明确「同义词/上下位词算覆盖」并给具体示例
# （短作答实验里 J3 用它把命中率从 71% 提到 100%；这里验证长作答场景没有退化）
M4 = M2.replace(
    """判定口径：意思相同即算覆盖（词序、构词、词性、单复数、同义替换都算）；
0.5 只用于「方向或程度明显不对」或「只说了半句」；0.0 仅当**完全没有表达该含义**。""",
    """判定口径（务必严格遵守）：
- **同义词与上下位词一律算覆盖**，绝不因为用词与要素或原文不同就判未覆盖。例：
  「低工资」〔原文 low pay〕← 学生写 "low wages" / "badly paid" → **1.0**；
  「新型无产阶级」〔原文 a new type of proletariats〕← "a new type of working class" → **1.0**；
- 判断方式：先看懂学生的意思，再问它是否等于该要素，**不要**在答案里搜与要素/原文相同或相近的词；
- 意思相同即算覆盖（词序、构词、词性、单复数、同义替换都算）；
- 0.5 只用于「方向或程度明显不对」或「只说了半句、要靠猜才成立」；
  学生答出实质、只是少列一个并列子点，应给 1.0；0.0 仅当**完全没有表达该含义**。""")

# 单要素拆分判分（精度上限参考）
M3_ONE = """你是剑桥 9699 A Level 社会学的阅卷官。请判断：学生的答案是否**表达了**下面这一个要素的含义？

术语：{term}
要素：{one}{one_en}
学生答案：{answer}

要求：只要意思相同就算表达（词序、构词、词性、单复数、同义替换、中英文都算）；
      学生答出要素的实质、只是少列了某个并列子点，也算表达。
只输出 JSON：{{"mentions":true,"reason":"不超过30字"}}"""


def load_key(var: str) -> str:
    for line in (ROOT / ".dev.vars").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(f"{var}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"no {var} in .dev.vars")


def call(prompt: str, url: str, model: str, key: str, max_tokens=900, reasoning="off", retries=3):
    body = {"model": model, "messages": [{"role": "user", "content": prompt}],
            "stream": False, "max_tokens": max_tokens, "temperature": 0.1}
    if "openrouter" in url:
        if reasoning == "exclude":
            body["reasoning"] = {"enabled": True, "exclude": True}
        elif reasoning == "on":
            body["reasoning"] = {"enabled": True}
        else:
            body["reasoning"] = {"enabled": False}
    data = json.dumps(body).encode()
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {key}", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                payload = json.loads(r.read().decode())
            ch = payload.get("choices") or []
            if ch:
                return (ch[0].get("message") or {}).get("content", "")
        except urllib.error.HTTPError as e:
            print(f"    HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:110]}")
        except Exception as e:                                     # noqa: BLE001
            print(f"    ERR {type(e).__name__}: {e}")
        time.sleep(2 * (attempt + 1))
    return None


def parse(txt: str, n_expected: int = 0):
    if not txt:
        return None
    m = re.search(r"\{.*\}", txt, re.S)
    if not m:
        return None
    try:
        obj = json.loads(re.sub(r",\s*([}\]])", r"\1", m.group(0)))
    except json.JSONDecodeError:
        return None
    if n_expected and isinstance(obj.get("coverage"), list):
        cov = [float(x) for x in obj["coverage"]][:n_expected]
        while len(cov) < n_expected:
            cov.append(0.0)
        obj["coverage"] = cov
    return obj


def verdict_from_kps(cov, kps, listing_only=False) -> str:
    """与 app/src/lib/ai.ts 的 verdictFromKeypoints **严格**对齐（用于题级档位）。

    ⚠️ 踩过的坑：无 `example` 要素时 `ex_need` 必须为 **0**（前端写作 `exIdx.length ? (...) : 0`）。
    首版写成 `1 if len(ex) <= 2 else 2`，于是「要素全 1.0」也被判 partial，
    造成一批假阳性（幸好复算时抓到，没据此误判线上）。
    """
    req = [i for i, k in enumerate(kps) if k.get("kind") != "example"]
    ex = [i for i, k in enumerate(kps) if k.get("kind") == "example"]
    if not cov or max(cov) <= 0:
        return "wrong"
    req_all = all(cov[i] >= 0.75 for i in req) if req else True
    ex_hits = sum(1 for i in ex if cov[i] >= 0.75)
    ex_need = (1 if len(ex) <= 2 else 2) if ex else 0
    if req_all and ex_hits >= ex_need and not listing_only:
        return "correct"
    if (sum(cov[i] for i in req) / len(req) if req else 1) >= 0.3 or ex_hits >= 1:
        return "partial"
    return "wrong"


def fmt_items(kps, with_en=True):
    out = []
    for i, k in enumerate(kps):
        mark = "·" if k.get("kind") == "example" else "★"
        en = f"　〔原文表述：{k['en']}〕" if (with_en and k.get("en")) else ""
        out.append(f"{i + 1}. {mark} {k['text']}{en}")
    return "\n".join(out)


def fmt_defs(defs, limit=600):
    return "\n".join(f"[{s}] {d[:limit]}" for s, d in (defs or {}).items()) or "（无）"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=4, help="取几个术语")
    ap.add_argument("--min-kp", type=int, default=3, help="要素数下限（多要素才有意义）")
    ap.add_argument("--variants", default="M0,M1,M2")
    ap.add_argument("--split", action="store_true", help="额外跑 M3（每要素单独调用，精度上限参考）")
    ap.add_argument("--styles", type=int, default=2, help="每个术语生成几种风格的学生作答")
    ap.add_argument("--provider", default="openrouter", choices=sorted(PROVIDERS))
    ap.add_argument("--reasoning", default="off", choices=["off", "on", "exclude"])
    ap.add_argument("--sleep", type=float, default=0.4)
    ap.add_argument("--out", default="C:/Users/rebir/AppData/Local/Temp/grading-lab-multi.json")
    args = ap.parse_args()

    url, model, keyvar = PROVIDERS[args.provider]
    key = load_key(keyvar)
    variants = [v.strip().upper() for v in args.variants.split(",") if v.strip()]

    pool = json.loads(POOL.read_text(encoding="utf-8"))
    cand = [r for r in pool
            if len([k for k in r.get("keypoints", []) if k.get("kind") != "example"]) >= args.min_kp
            and all(k.get("en") for k in r.get("keypoints", [])[:3])]
    # 分层：每隔一段取一个，覆盖不同单元
    step = max(1, len(cand) // args.n)
    picked = cand[::step][: args.n]
    print(f"provider={args.provider} model={model} reasoning={args.reasoning}")
    print(f"候选术语 {len(cand)} → 取 {len(picked)} 个；变体 {variants}{'+M3' if args.split else ''}"
          f"；每术语 {args.styles} 种学生作答\n")

    results = []
    for rec in picked:
        kps = rec["keypoints"]
        defs = fmt_defs(rec.get("source_defs"))
        items_en = fmt_items(kps, with_en=True)
        zeros = ",".join(["0.0"] * len(kps))
        for si in range(args.styles):
            style = GEN_STYLES[si % len(GEN_STYLES)]
            ans = call(GEN.format(term=rec["term"], items=fmt_items(kps, False), defs=defs),
                       url, model, key, max_tokens=700, reasoning="off")
            if not ans or len(ans.strip()) < 20:
                print(f"  !! 生成失败：{rec['term']}")
                continue
            ans = ans.strip()
            print(f"\n### {rec['term']}（风格 {si + 1}）\n作答：{ans[:150]}")

            row = {"term": rec["term"], "style": si + 1, "answer": ans,
                   "n_kp": len(kps), "got": {}}
            for v in variants:
                # M0n = 回退到「要素行不带英文表述」的旧形态（1.8.3 之前），
                #       用于验证「要素级英文」是不是防漏判的关键。
                items = items_en if v != "M0n" else fmt_items(kps, with_en=False)
                if v in ("M0", "M0n"):
                    p = M0.format(term=rec["term"], defs=defs, items=items, answer=ans, zeros=zeros)
                elif v == "M1":
                    p = M1.format(term=rec["term"], defs=defs, items=items, answer=ans, zeros=zeros)
                elif v == "M4":
                    p = M4.format(term=rec["term"], defs=defs, items=items, answer=ans, zeros=zeros)
                else:
                    p = M2.format(term=rec["term"], defs=defs, items=items, answer=ans, zeros=zeros)
                obj = parse(call(p, url, model, key, max_tokens=1400, reasoning=args.reasoning), len(kps)) or {}
                cov = [float(x) for x in (obj.get("coverage") or [])]
                while len(cov) < len(kps):
                    cov.append(0.0)
                row["got"][v] = {"coverage": cov[:len(kps)],
                                 "verdict": verdict_from_kps(cov, kps, bool(obj.get("listing_only"))),
                                 "reason": obj.get("reason", "")}
                time.sleep(args.sleep)

            if args.split:
                cov3 = []
                for i, k in enumerate(kps):
                    one_en = f"　（原文表述：{k['en']}）" if k.get("en") else ""
                    o = parse(call(M3_ONE.format(term=rec["term"], one=k["text"], one_en=one_en, answer=ans),
                                   url, model, key, max_tokens=400, reasoning=args.reasoning)) or {}
                    cov3.append(1.0 if o.get("mentions") is True else 0.0)
                    time.sleep(args.sleep)
                row["got"]["M3"] = {"coverage": cov3, "verdict": verdict_from_kps(cov3, kps),
                                    "reason": "（每要素单独判定）"}

            for v, g in row["got"].items():
                miss = [i + 1 for i, x in enumerate(g["coverage"]) if x < 0.75]
                print(f"   {v}: {g['verdict']:8s} 误杀要素 {miss or '无'}  {g['reason'][:38]}")
            results.append(row)

    # ---- 汇总 ----
    print("\n" + "=" * 78)
    print("要素级统计（作答保证覆盖全部要素 → 任何 <0.75 都算误杀）")
    all_v = variants + (["M3"] if args.split else [])
    total_kp = sum(r["n_kp"] for r in results)
    for v in all_v:
        miss = sum(1 for r in results for x in r["got"][v]["coverage"] if x < 0.75)
        bad = [r["term"] for r in results if any(x < 0.75 for x in r["got"][v]["coverage"])]
        hit = total_kp - miss
        print(f"  {v}: 要素命中 {hit}/{total_kp} = {hit / total_kp * 100:.0f}%"
              f"   误杀 {miss}   受影响术语 {len(bad)}/{len(results)}")
    print("\n题级档位（应全部 correct）：")
    for v in all_v:
        n_ok = sum(1 for r in results if r["got"][v]["verdict"] == "correct")
        bad = [(r["term"], r["got"][v]["verdict"]) for r in results if r["got"][v]["verdict"] != "correct"]
        print(f"  {v}: correct {n_ok}/{len(results)}" + (f"   非 correct：{bad}" if bad else ""))

    Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n明细写入 {args.out}")


if __name__ == "__main__":
    main()
