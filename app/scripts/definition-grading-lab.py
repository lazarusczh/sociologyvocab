"""要素级判分实验台：同一批「改写 / 反向 / 跨语言」案例，对比不同提示词策略。

为什么需要：现有的 definition-grading-selftest.py 是**整条定义**级别的（full/partial/wrong），
测不出「学生换了个说法就被判未覆盖」这类问题 —— 实测案例：要素「低工作保障」（原文 low job security），
学生写 "low-security jobs" 被判未覆盖。

本脚本聚焦**单要素识别**（比端到端更能看清模型能力），内置人工标注的期望值，对比：

  A baseline   —— 现状口径：给 0/0.5/1 连续覆盖度（>=0.75 视为覆盖）
  B binary     —— 改成二值问答："学生答案是否表达了该含义？"并要求引用对应片段
  C paraphrase —— 先让模型自己列出该要素的若干等价表述，再判断是否命中
  D restate    —— 先无评价地重述学生答案，再据此判断

用法：
  python scripts/definition-grading-lab.py --strategy A,B,C,D --provider openrouter
  python scripts/definition-grading-lab.py --strategy C --provider ms --only precariat
"""
import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
PROVIDERS = {
    "openrouter": ("https://openrouter.ai/api/v1/chat/completions",
                   "nvidia/nemotron-3-super-120b-a12b:free", "OPENROUTER_API_KEY"),
    "agnes": ("https://apihub.agnes-ai.com/v1/chat/completions",
              "agnes-2.5-flash", "AGNES_API_KEY"),
    "ms": ("https://api-inference.modelscope.cn/v1/chat/completions",
           "Qwen/Qwen3.5-122B-A10B", "MODELSCOPE_API_KEY"),
}

# ===== 案例集：expect=1 表示该要素应被判为「已表达」，0 表示相反 =====
CASES = [
    # —— 同义改写 / 词序变化（用户实测踩到的：全部期望 1）——
    ("Precariat", "低工作保障", "low job security",
     "Precariat members are in low-security jobs with little stability.", 1, "词序+复合词化"),
    ("Precariat", "低技能体力劳动工作", "low skilled manual labour jobs",
     "They do manual work that needs few skills.", 1, "改写：needs few skills"),
    ("Precariat", "低工资", "low pay",
     "They are badly paid for what they do.", 1, "同义：badly paid"),
    ("Wealth", "累积的金钱及其他财产", "The accumulated money and other properties",
     "Money and property that a person has built up over time.", 1, "语序+同义：built up"),
    ("Toxic childhood", "现代科技变化对儿童造成危害", "Modern technology changes have harmed children",
     "Technology has damaged childhood today.", 1, "同义：damaged"),
    ("Hidden curriculum", "学生在学校学到的但课堂外的内容", "things students learn in schools but outside of classroom",
     "What pupils pick up at school outside formal lessons.", 1, "改写：pick up / formal lessons"),
    ("Equality", "以政治、宗教、投票等各领域平等权为核心的人权观",
     "A way of defining human rights that focus on the equal right in realms such as political beliefs, religious beliefs, voting",
     "A way of defining human rights that centres on equal rights in areas like voting and religion.", 1, "改写：centres on / areas like"),
    ("Marginalised masculinity", "因长期失业、家庭主要养家者角色逆转而被边缘化的男性气质",
     "A new type of masculinity that men are marginalised due to long-term unemployment and a reversal of the major provider role",
     "Men who feel pushed to the margins because they have lost their role as the main earner.", 1, "改写：main earner / pushed to the margins"),
    ("Islamophobia", "针对穆斯林及来自伊斯兰国家的移民的公众恐惧", "the public fears for the ethnic minority groups and immigrants that have religious belief of Islam",
     "Public anxiety about Muslims and immigrants from Islamic countries.", 1, "同义：anxiety"),
    ("Wealth", "累积的金钱及其他财产", "The accumulated money and other properties",
     "房屋、汽车、珠宝等积累起来的财富。", 1, "中文作答"),
    ("Precariat", "低工作保障", "low job security",
     "工作不稳定、随时可能失业的一群人。", 1, "中文作答（跨语言）"),
    # —— 反向 / 无关（期望 0，防放水）——
    ("Precariat", "低工作保障", "low job security",
     "They enjoy high job security and permanent contracts.", 0, "方向相反"),
    ("Wealth", "累积的金钱及其他财产", "The accumulated money and other properties",
     "The monthly income a worker earns from employment.", 0, "income ≠ wealth"),
    ("Toxic childhood", "现代科技变化对儿童造成危害", "Modern technology changes have harmed children",
     "Children today spend more time outdoors than in the past.", 0, "无关"),
    ("Precariat", "低技能体力劳动工作", "low skilled manual labour jobs",
     "They are highly trained professionals in well-paid roles.", 0, "方向相反"),
    # —— 半对（期望 0.5 档：单要素层面视为「未达标但沾到」，观察是否被误判为覆盖）——
    ("Marginalised masculinity", "因长期失业、家庭主要养家者角色逆转而被边缘化的男性气质",
     "A new type of masculinity that men are marginalised due to long-term unemployment and a reversal of the major provider role",
     "A new type of masculinity.", 0, "只答上位词，未含边缘化机制"),
]

A = """你是一位社会学阅卷官。请判断学生的答案对该要素的覆盖程度。
术语：{term}
要素：{kp}　（权威来源原文：{en}）
学生答案：{answer}
输出覆盖度 coverage：1.0 = 表达到位；0.5 = 只沾到一部分；0.0 = 没提到或说错。
只输出 JSON：{{"coverage":1.0,"reason":"不超过30字"}}"""

B = """你是一位社会学阅卷官。请判断学生的答案**是否表达了**下面这个要素的含义。
术语：{term}
要素：{kp}　（权威来源原文：{en}）
学生答案：{answer}
判定要求：允许同义改写、词序/构词变化、中英文作答；只有「完全没有表达该含义」或「方向相反」才算 false。
只输出 JSON：{{"mentions":true,"quote":"学生答案中对应的片段（没有则空字符串）","reason":"不超过30字"}}"""

C = """你是一位社会学阅卷官，正在做要素覆盖判定。
术语：{term}
要素：{kp}　（权威来源原文：{en}）
学生答案：{answer}

第一步：先列出 5 种**可以接受的等价表述**（包含同义替换、词序与构词变化、主动被动转换、中英文均可），
不要只抄原句。
第二步：判断学生答案是否命中了其中任意一种的含义（允许更宽泛或更具体的表达）。
只输出 JSON：{{"paraphrases":["...","...","...","...","..."],"mentions":true,"reason":"不超过30字"}}"""

D = """你是一位社会学阅卷官，正在做要素覆盖判定。请分两步。
术语：{term}
要素：{kp}　（权威来源原文：{en}）
学生答案：{answer}

第一步：**不加评价地重述**学生答案在说什么，保留其确切含义（特别是程度与方向）。
第二步：基于重述，判断该要素是否被表达（允许同义改写、词序/构词变化、中英文）。
只输出 JSON：{{"restate":"一句话重述","mentions":true,"reason":"不超过30字"}}"""

PROMPTS = {"A": A, "B": B, "C": C, "D": D}


def load_key(var: str) -> str:
    for line in (ROOT / ".dev.vars").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(f"{var}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"no {var} in .dev.vars")


def call(prompt: str, url: str, model: str, key: str, max_tokens=500, retries=3):
    body = {"model": model, "messages": [{"role": "user", "content": prompt}],
            "stream": False, "max_tokens": max_tokens, "temperature": 0.1}
    if "openrouter" in url:
        body["reasoning"] = {"enabled": False}
    elif "modelscope" in url:
        body["enable_thinking"] = False
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
            print(f"    BAD PAYLOAD: {str(payload)[:120]}")
        except urllib.error.HTTPError as e:
            print(f"    HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:110]}")
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
        return json.loads(re.sub(r",\s*([}\]])", r"\1", m.group(0)))
    except json.JSONDecodeError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", default="A,B,C,D")
    ap.add_argument("--provider", default="openrouter", choices=sorted(PROVIDERS))
    ap.add_argument("--only", default="", help="只跑术语名包含该子串的案例")
    ap.add_argument("--sleep", type=float, default=0.5)
    ap.add_argument("--out", default="C:/Users/rebir/AppData/Local/Temp/grading-lab.json")
    args = ap.parse_args()

    url, model, keyvar = PROVIDERS[args.provider]
    key = load_key(keyvar)
    strategies = [s.strip().upper() for s in args.strategy.split(",") if s.strip()]
    cases = [c for c in CASES if args.only.lower() in c[0].lower()] if args.only else CASES
    print(f"provider={args.provider} model={model}  策略={strategies}  案例={len(cases)}\n")

    results = []
    for term, kp, en, ans, expect, note in cases:
        row = {"term": term, "kp": kp, "answer": ans, "expect": expect, "note": note, "got": {}}
        for s in strategies:
            txt = call(PROMPTS[s].format(term=term, kp=kp, en=en, answer=ans), url, model, key)
            obj = parse(txt) or {}
            if s == "A":
                cov = obj.get("coverage")
                hit = 1 if isinstance(cov, (int, float)) and float(cov) >= 0.75 else 0
            else:
                hit = 1 if obj.get("mentions") is True else 0
            row["got"][s] = {"hit": hit, "obj": obj}
            time.sleep(args.sleep)
        flags = " ".join(f"{s}:{'✓' if row['got'][s]['hit'] == expect else '✗'}" for s in strategies)
        print(f"{'OK ' if all(row['got'][s]['hit'] == expect for s in strategies) else '!! '}"
              f"{term[:22]:24s} 期望{expect}  {flags}   {note}")
        results.append(row)

    print("\n=== 逐策略准确率（要素级：应覆盖 / 不应覆盖）===")
    for s in strategies:
        ok = sum(1 for r in results if r["got"][s]["hit"] == r["expect"])
        pos = [r for r in results if r["expect"] == 1]
        neg = [r for r in results if r["expect"] == 0]
        fn = sum(1 for r in pos if r["got"][s]["hit"] == 0)     # 误杀（应覆盖却判未覆盖）
        fp = sum(1 for r in neg if r["got"][s]["hit"] == 1)     # 放水（不该覆盖却判覆盖）
        print(f"  策略 {s}: {ok}/{len(results)} = {ok / len(results) * 100:.0f}%"
              f"   误杀 {fn}/{len(pos)}   放水 {fp}/{len(neg)}")

    print("\n=== 失败明细（策略 A vs 最强策略）===")
    for s in strategies:
        bad = [r for r in results if r["got"][s]["hit"] != r["expect"]]
        if bad:
            print(f"  策略 {s}:")
            for r in bad:
                o = r["got"][s]["obj"]
                print(f"    - {r['term']} / {r['kp'][:16]} · {r['note']} ⇒ {str(o)[:100]}")

    Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n明细写入 {args.out}")


if __name__ == "__main__":
    main()
