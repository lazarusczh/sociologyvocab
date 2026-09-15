# 主站 AI 通路探针：验证 POST /app-api/ai/complete 是否可用，并对比三档（nemotron / agnes / ms）
#
# 凭据（三选一）：
#   --token <access_token>           直接用浏览器里拿到的教师 token（Supabase 会话 1 小时有效）
#   --email x --password y           用账号密码换 token（走 Supabase password grant）
#   不带凭据                          只做可达性探测（预期 401，用来确认端点存在）
#
# 用法：
#   python scripts/app-api-probe.py
#   python scripts/app-api-probe.py --token eyJ...
#   python scripts/app-api-probe.py --email a@b.c --password *** --tiers nemotron,agnes,ms
import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://9699vocab.cn"
PROBE_PROMPT = ("请判断这个学生答案是否覆盖术语的要素，只输出 JSON：\n"
                "术语：Patriarchy\n要素：1. 男性主导、女性从属  2. 男性通过社会制度维持支配\n"
                '学生答案：父权制指男性在社会中占主导地位。\n'
                '{"coverage":[1.0,0.0],"listing_only":false,"reason":"..."}')


def dev_var(name: str) -> str:
    f = ROOT / ".dev.vars"
    if not f.exists():
        return ""
    for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


BROWSER_HEADERS = {
    # Cloudflare 会拦截数据中心 IP + 非浏览器 UA 的请求（实测 403 error code: 1010）
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def post(url: str, payload: dict, token: str = "", timeout: int = 180):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={**BROWSER_HEADERS, "Content-Type": "application/json",
                 **({"Authorization": f"Bearer {token}"} if token else {})})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8")), (time.time() - t0)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")[:400], (time.time() - t0)
    except Exception as e:                                     # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}", (time.time() - t0)


def login(email: str, password: str) -> str:
    url = f"{dev_var('SUPABASE_URL')}/auth/v1/token?grant_type=password"
    req = urllib.request.Request(
        url, data=json.dumps({"email": email, "password": password}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "apikey": dev_var("SUPABASE_ANON_KEY")})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode()).get("access_token", "")
    except urllib.error.HTTPError as e:
        print("登录失败:", e.code, e.read().decode()[:200])
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default="")
    ap.add_argument("--email", default="")
    ap.add_argument("--password", default="")
    ap.add_argument("--tiers", default="nemotron,agnes,ms")
    ap.add_argument("--fallback", action="store_true", help="允许降级（默认关闭，便于观测单档真实表现）")
    ap.add_argument("--prompt", default=PROBE_PROMPT)
    ap.add_argument("--endpoint", default=f"{BASE}/app-api/ai/complete")
    args = ap.parse_args()

    token = args.token or (login(args.email, args.password) if args.email else "")

    if not token:
        print("【可达性探测】未提供凭据，预期 401 unauthorized")
        status, body, ms = post(args.endpoint, {"prompt": "ping"})
        print(f"  HTTP {status}  {str(body)[:200]}")
        print("  端点存在" if status in (401, 403) else "  端点异常，请检查部署")
        return

    print(f"凭据就绪（token 长度 {len(token)}），开始逐档测试（fallback={args.fallback}）\n")
    for tier in [t.strip() for t in args.tiers.split(",") if t.strip()]:
        status, body, ms = post(args.endpoint,
                                {"prompt": args.prompt, "tier": tier, "maxTokens": 400,
                                 "fallback": args.fallback}, token)
        if status == 200 and isinstance(body, dict):
            txt = (body.get("text") or "").strip().replace("\n", " ")
            print(f"[{tier:9s}] OK  model={body.get('model')}  {ms:.1f}s  "
                  f"fellBack={body.get('fellBack')}")
            print(f"           → {txt[:220]}")
        else:
            print(f"[{tier:9s}] FAIL HTTP {status}  {str(body)[:220]}")
        print()


if __name__ == "__main__":
    main()
