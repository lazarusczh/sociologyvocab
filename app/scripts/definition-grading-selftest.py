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
    # ★ 2026-09-21：默认模型对齐线上判分档（super-120b → ultra-550b，见 worker/ai/text.ts 的 OR_MODEL）
    "openrouter": ("https://openrouter.ai/api/v1/chat/completions",
                   "nvidia/nemotron-3-ultra-550b-a55b:free", "OPENROUTER_API_KEY"),
    # ★ 2026-09-21 新增：Agnes 国内节点（.cn）。本地直连与 CF 出口都已实测可用，
    #   免费、不限量，故纳入对照组 —— 用于回答「agnes 与 ultra 谁更适合判分」。
    "agnes": ("https://apihub.agnes-ai.cn/v1/chat/completions",
              "agnes-2.5-flash", "AGNES_API_KEY"),
}
STOP = {"the", "a", "an", "of", "and", "in", "for", "to", "on", "with", "by", "as", "is", "are"}

# 与线上 lib/ai.ts 的 SOURCE_LABEL 一致（参考原文的来源标注）
SOURCE_LABEL = {
    "main": "主站词库（学生日常练习所依据的定义）",
    "tb1": "教材 Haralambos",
    "tb2": "教材 Livesey Coursebook",
    "igcse0495": "0495 官方 glossary",
}

# ★ 2026-09-21：本 PROMPT 与线上 `app/src/lib/ai.ts` 的 `gradeDefinition` **保持同构**。
#   原先是旧版 —— 缺「两步法 / ★·标记 / 参考原文 / 0.5 边界（少列一个并列子点应给 1.0）」
#   等条款，会让脚本成绩**系统性偏严、不能代表线上**。
#   ⚠️ prompt 现在有两份真源（TS 一份、Python 一份），改线上务必同步这里，否则必然漂移。
PROMPT = """你是剑桥 9699 A Level 社会学的阅卷官。学生在做「术语定义默写」。
请**分两步**作答：先理解学生说了什么，再逐要素判定覆盖程度（只判覆盖度，不要给档位）。

术语：{term}
{refs}
核心要素（★ = 定义主干，必须答到；· = 并列举例，举出其中若干项即可）：
{list}

学生答案：{answer}

**第一步**：用 1~3 条列出「学生这段话表达了哪些含义」——只描述学生的意思，
不要改写成要素的措辞、不要补充学生没说过的内容。
**第二步**：把第一步的清单与核心要素逐条对照，给出覆盖度 coverage：
- ★ 主干要素：1.0 = 表达到位；0.5 = 只沾到一部分（说了半句、过于笼统）；0.0 = 没提到或说错
- · 举例要素：**只给 0.0 或 1.0 两档**（明确举出了这个例子 → 1.0；没提到或只是笼统说"有危害/有多种形式" → 0.0）

另外判断 listing_only（"是否只是罗列关键词"）：
- true 仅指**把关键词成串堆在一起、完全没有形成句子**（如"学业压力 屏幕时间 商业化"这样一串词）；
- 只要答案有主谓结构（如"儿童面临多种危害，例如学业压力、屏幕时间和商业化"），即使中间夹着举例，也算**正常陈述 → false**。

判定口径（务必严格执行）：
- **判定依据只有「学生答案」本身**：参考原文与要素说明只用于帮你理解这个术语和可接受的表述，
  **绝不能**把参考原文里的内容当成学生说过的内容 —— 学生没写的内容，即使原文里有，也必须判 0.0；
- **要素以英文表述为准**（要素给了英文时，按英文含义判断；中文说明仅供参考，不构成额外要求）；
- 用中文或英文作答都算；**只要与「核心要素」或「参考原文」意思相同即算覆盖**，不要求用词一致、更不要求复述原文；
- **同义词与上下位词一律算覆盖**（本任务最易出错处）：绝不因为用词与要素/原文不同就判未覆盖。例：
  「低工资」〔原文 low pay〕← 学生写 "low wages" / "badly paid" → **1.0**；
  「低工作保障」〔low job security〕← "low-security jobs" / "工作保障低" → **1.0**；
  「新型无产阶级」〔a new type of proletariats〕← "a new type of working class" → **1.0**；
- **判断方式**：先看懂学生的意思，再问它是否等于该要素，**不要**在答案里搜与要素/原文相同或相近的词去打勾；
  词序调整、复合词化、词性转换、单复数/时态变化同样都算覆盖；
- **0.5 的边界（最容易误判，务必严格）**：只有「方向或程度明显不对」或「只说了半句、要靠猜才成立」才给 0.5。
  **学生答出了要素的实质、只是少列了其中一个并列子点，不算 0.5，应给 1.0**：
  例①：要素「因长期失业、家庭主要养家者角色逆转而被边缘化的男性气质」，
  学生写 "men pushed to the margins because they lost their role as the main earner"
  （答出"被边缘化 + 失去养家角色"，只是没写"长期失业"）→ **1.0**；
  例②：要素「累积的金钱及其他财产」，学生写「房屋、汽车、珠宝等积累起来的财富」→ **1.0**；
- 0.0 仅当学生**完全没有表达该含义**（含说反了）；
- **成档与否只看「核心要素」清单**——不要额外要求学生答出参考原文里的其它内容；
- 若学生举出的例子**已经体现了某个 ★ 主干要素**（例如主干说"科技变化造成危害"，学生举了"屏幕时间过长"），该主干要素可给 0.5 以上。

只输出 JSON（不要 markdown、不要解释）：
{{"restate":["学生表达的含义1","含义2"],"coverage":[1.0,0.0],"listing_only":false,"reason":"不超过40字的中文理由","confidence":0.0}}"""


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


def call_llm(prompt: str, base: str, model: str, key: str, max_tokens=1200, retries=3):
    body = {"model": model, "messages": [{"role": "user", "content": prompt}],
            "stream": False, "max_tokens": max_tokens, "temperature": 0.2,
            "enable_thinking": False}
    if "openrouter" in base:                              # nemotron 默认吐推理，需关掉
        body["reasoning"] = {"enabled": False}
    # ★ 2026-09-21：Agnes 强制 JSON 输出（与线上 worker/ai/text.ts 保持一致，便于对照可比）。
    #   实测不加时它把 JSON 包在 ```json 围栏里；其推理**无法关闭**（enable_thinking 被忽略，
    #   reasoning 与正文共享 max_tokens，实测一次用 140~255），故 max_tokens 默认提到 1200。
    if "agnes-ai" in base:
        body["response_format"] = {"type": "json_object"}
        body.pop("enable_thinking", None)
    data = json.dumps(body).encode("utf-8")
    for attempt in range(retries):
        req = urllib.request.Request(base, data=data, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {key}", "User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                payload = json.loads(r.read().decode("utf-8"))
            choices = payload.get("choices") or []
            if not choices:                                     # OpenRouter 偶发返回无 choices
                if verbose:
                    print(f"  BAD PAYLOAD: {str(payload)[:160]}")
                time.sleep(3 * (attempt + 1))
                continue
            return (choices[0].get("message") or {}).get("content", "")
        except urllib.error.HTTPError as e:
            print(f"    HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:150]}")
            time.sleep(3 * (attempt + 1))
        except Exception as e:                            # noqa: BLE001
            print(f"    ERR {type(e).__name__}: {e}")
            time.sleep(3 * (attempt + 1))
    return None


# ===== 主站 AI 通路（/app-api/ai/complete）：走线上 secret，不占用本地/魔搭 key =====
BASE_URL = "https://9699vocab.cn"
BROWSER_HEADERS = {
    # Cloudflare 拦数据中心 UA（实测 403 error code: 1010），必须带浏览器 UA
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def supabase_login(email: str, password: str) -> str:
    url = f"{load_key('SUPABASE_URL') or ''}/auth/v1/token?grant_type=password"
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={
        **BROWSER_HEADERS, "Content-Type": "application/json",
        "apikey": load_key("SUPABASE_ANON_KEY") or ""})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode()).get("access_token", "")
    except urllib.error.HTTPError as e:
        print("登录失败:", e.code, e.read().decode()[:200])
        return ""


def call_via_api(prompt: str, token: str, tier: str = "nemotron", max_tokens: int = 600,
                 fallback: bool = False, endpoint: str = f"{BASE_URL}/app-api/ai/complete"):
    body = json.dumps({"prompt": prompt, "tier": tier, "maxTokens": max_tokens,
                       "fallback": fallback}).encode()
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        **BROWSER_HEADERS, "Content-Type": "application/json",
        "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode()).get("text", "")
    except urllib.error.HTTPError as e:
        print(f"    HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:150]}")
    except Exception as e:                                    # noqa: BLE001
        print(f"    ERR {type(e).__name__}: {e}")
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


def verdict_from_keypoints(coverage: list, kps: list, listing_only: bool) -> str:
    """档位规则 —— 与线上 `app/src/lib/ai.ts` 的 `verdictFromKeypoints` **同构**。

    ★ 主干要素必须**每一项都达标**（平均达标不算）；· 举例要素举够数即可
    （≤2 项时举 1 项、≥3 项时举 2 项）。缺失索引按 0 计。
    早前这里用的是"全要素平均覆盖度 ≥ 递减门槛"，与线上口径不同，会让脚本成绩失真。
    """
    try:
        vals = [float(x) for x in (coverage or [])]
    except (TypeError, ValueError):
        return "PARSE_FAIL"
    if not vals or max(vals) <= 0:
        return "wrong"

    def v(i: int) -> float:
        return vals[i] if i < len(vals) else 0.0

    req_idx = [i for i, k in enumerate(kps) if k.get("kind") != "example"]
    ex_idx = [i for i, k in enumerate(kps) if k.get("kind") == "example"]

    req_score = (sum(v(i) for i in req_idx) / len(req_idx)) if req_idx else 1.0
    req_all_ok = all(v(i) >= 0.75 for i in req_idx)
    ex_hits = sum(1 for i in ex_idx if v(i) >= 0.75)
    ex_need = (1 if len(ex_idx) <= 2 else 2) if ex_idx else 0

    if req_all_ok and ex_hits >= ex_need and not listing_only:
        return "correct"
    if req_score >= 0.3 or ex_hits >= 1:
        return "partial"
    return "wrong"


def partial_excerpt(text: str) -> str:
    """只取一个分句，模拟"只答出一半"的学生答案（full 的子集，预期只覆盖 1 个要素）。"""
    parts = [p for p in re.split(r"(?<=[,;.])\s+", text.strip()) if p.strip()]
    return parts[0] if parts else text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10, help="抽多少个术语（每个术语 3 个样本）")
    ap.add_argument("--via", default="api", choices=["api", "direct"],
                    help="api=走线上主站通路（推荐，不烧本地 key）；direct=本地直连各家 API")
    ap.add_argument("--token", default="", help="教师 access token（浏览器登录后可从会话里取）")
    ap.add_argument("--email", default="")
    ap.add_argument("--password", default="")
    ap.add_argument("--api-tier", default="nemotron", choices=["nemotron", "agnes", "ms", "auto"])
    ap.add_argument("--fallback", action="store_true", help="允许跨档降级（默认关，便于观测单档表现）")
    ap.add_argument("--max-tokens", type=int, default=600)
    ap.add_argument("--provider", default="auto", choices=["auto", "ms", "openrouter", "agnes"])
    ap.add_argument("--repeat", type=int, default=1, help="同一答案重复判几次（测一致性）")
    ap.add_argument("--model", default="", help="覆盖默认模型 id")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--tier", default="high", choices=["high", "low", "all"],
                    help="只测高置信术语（core ≥2 个且多源互证），或全部")
    args = ap.parse_args()

    # ---- 提供者选择：默认走线上主站通路（/app-api/ai/complete），不烧本地魔搭 key ----
    if args.via == "api":
        token = args.token or (supabase_login(args.email, args.password) if args.email else "")
        if not token:
            raise SystemExit("api 模式需要 --token <access_token>，或 --email/--password 登录换取")
        complete = lambda p: call_via_api(p, token, args.api_tier, args.max_tokens, args.fallback)  # noqa: E731
        print(f"via=api  endpoint=/app-api/ai/complete  tier={args.api_tier}  fallback={args.fallback}")
    else:
        prov = args.provider
        if prov == "auto":
            prov = "openrouter" if load_key("OPENROUTER_API_KEY") else "ms"
        base, model, keyvar = PROVIDERS[prov]
        if args.model:
            model = args.model
        key = load_key(keyvar)
        if not key:
            raise SystemExit(f"{keyvar} 未在 app/.dev.vars 中配置")
        complete = lambda p: call_llm(p, base, model, key)                                     # noqa: E731
        print(f"via=direct  provider={prov} model={model}")

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

    def ref_definition(term: str, prefer: str) -> str:
        """按术语的「参考来源」取定义原文：main → 主站词库；tb1/tb2/igcse0495 → 教材 Key terms / 官方 glossary。
        判分基准应与学生所学口径一致（方案 13.3 的修正方向）。"""
        if prefer in ("", "main"):
            return main_def.get(term, "")
        mt = toks(term)
        for st, d in ext.get(prefer, []):
            if not st:
                continue
            inter, union = len(mt & st), len(mt | st)
            jac = (inter / union) if union else 0
            subset = ((mt <= st and len(mt) >= 2 and len(st) - len(mt) <= 1)
                      or (st <= mt and len(st) >= 2 and len(mt) - len(st) <= 1))
            if jac >= 0.6 or subset:
                return d
        return main_def.get(term, "")

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
        prefer = r.get("reference") or "main"
        ref = ref_definition(r["term"], prefer)
        if len(ref) < 20:
            continue
        wrong_ref = next((x for x in pool if x.get("paper") == r.get("paper")), None)
        wrong_def = (ref_definition(wrong_ref["term"], wrong_ref.get("reference") or "main")
                     if wrong_ref else "This term is not defined here.")
        samples.append((r, "full", ref, "correct"))
        # partial：只覆盖清单里的第 1 个要素（对 1 要素术语无法构造"半对"，跳过）。
        # 早前用"定义首分句"当半对，遇到 main 定义只有一句话时与 full 完全相同，导致指标虚低。
        kp_texts = [k.get("text", "") for k in r.get("keypoints", []) if k.get("text")]
        if len(kp_texts) >= 2:
            samples.append((r, "partial", f"该术语指：{kp_texts[0]}。", "partial"))
        samples.append((r, "wrong", wrong_def[:300], "wrong"))

    print(f"术语 {len(picked)} 个 → 样本 {len(samples)} 个 × repeat {args.repeat}\n")
    results, correct_cnt = [], 0
    for idx, (rec, kind, ans, expect) in enumerate(samples, 1):
        # 判分清单 = 参考来源的必踩点（方案 13.3 修正后：以参考来源为中心，其他来源独有内容进 bonus）
        cores = rec["keypoints"]

        # 要素行与线上一致：★ 主干 / · 举例；**英文表述在前作判定依据**，中文仅作参考说明
        def kp_line(j: int, k: dict) -> str:
            mark = "·" if k.get("kind") == "example" else "★"
            if k.get("en"):
                return f"{j+1}. {mark} {k.get('en')}　（中文说明，仅供参考：{k.get('text')}）"
            return f"{j+1}. {mark} {k.get('text')}　（该要素暂无英文表述，请按此中文含义判断）"

        kp_lines = "\n".join(kp_line(j, k) for j, k in enumerate(cores))
        # 参考原文（英文）：与线上一样作为"语义等价"的参照依据
        prefer = rec.get("reference") or "main"
        ref_text = ref_definition(rec["term"], prefer)
        refs = (f"\n参考原文（英文，来自权威来源，供你判断语义等价用）：\n"
                f"- [{SOURCE_LABEL.get(prefer, prefer)}] {ref_text.strip()}\n"
                ) if ref_text.strip() else ""
        prompt = PROMPT.format(term=rec["term"], refs=refs, list=kp_lines, answer=ans)
        verdicts, rec_coverage, rec_reason, rec_conf = [], [], "", ""
        for _ in range(args.repeat):
            v = parse_verdict(complete(prompt))
            if v:
                verdicts.append(verdict_from_keypoints(v.get("coverage"), cores, bool(v.get("listing_only"))))
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
