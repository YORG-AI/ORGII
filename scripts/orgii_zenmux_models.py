#!/usr/bin/env python3
"""
ORG-2 ZenMux 模型同步 (E4 迁移自 OpenClaw skill zenmux-models)

OpenClaw 原 skill 的本质：从 ZenMux 拉最新模型列表，生成 OpenAI/Anthropic/Vertex
三协议 provider 配置。ORG-2 不用 openclaw.json，改为：
  - 从 ORG-2 网关 (TiyGate /v1/models) 拉当前可用模型
  - 按 provider 分组 + 标注三协议归属（openai-completions / anthropic-messages / vertex-ai）
  - 给出 ORG-2 credentials/integrations 配置参考

host 侧只读，不改任何配置。

用法:
  python3 orgii_zenmux_models.py             # 列出 TiyGate 当前可用模型（分组+协议）
  python3 orgii_zenmux_models.py --raw       # 原始 id 列表
  python3 orgii_zenmux_models.py --base URL  # 指定网关 base（默认 TiyGate 127.0.0.1:3099/v1）

env:
  ORGII_GATEWAY_BASE  覆盖默认网关 base_url
  ORGII_CREDENTIALS   覆盖默认 credentials.json 路径
"""
import json, sys, os, argparse, urllib.request

DEFAULT_CREDS = os.environ.get(
    "ORGII_CREDENTIALS",
    "/home/hy/clawd/projects/orgii-data/credentials.json",
)
DEFAULT_BASE = os.environ.get("ORGII_GATEWAY_BASE", "")

# ZenMux 三协议（OpenClaw E4 对照表）
PROTOCOLS = {
    "openai":  ("OpenAI",   "zenmux",           "https://zenmux.ai/api/v1",        "openai-completions"),
    "anthropic": ("Anthropic", "zenmux-anthropic", "https://zenmux.ai/api/anthropic", "anthropic-messages"),
    "vertex":  ("Vertex AI", "zenmux-vertex",    "https://zenmux.ai/api/vertex-ai", "google-generative-ai"),
}


def protocol_of(model_id):
    """按 provider 前缀推断推荐协议。"""
    m = model_id.lower()
    if m.startswith("anthropic/") or "claude" in m:
        return "anthropic"
    if m.startswith("google/") or "gemini" in m:
        return "vertex"
    return "openai"


def load_gateway_key(creds_path):
    try:
        d = json.load(open(creds_path))
        c = d.get("credentials", {}).get("zenmux-tiygate", {})
        return c.get("api_key", ""), c.get("base_url", "")
    except Exception:
        return "", ""


def fetch_models(base, key):
    url = base.rstrip("/") + "/models"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.loads(r.read())
    data = d.get("data", d)
    return [x.get("id") for x in data if isinstance(x, dict) and x.get("id")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE, help="网关 base_url")
    ap.add_argument("--creds", default=DEFAULT_CREDS)
    ap.add_argument("--raw", action="store_true")
    args = ap.parse_args()

    key, cred_base = load_gateway_key(args.creds)
    base = args.base or cred_base
    if not base:
        print("❌ 无网关 base_url（credentials.json 无 zenmux-tiygate.base_url，且未传 --base）",
              file=sys.stderr)
        sys.exit(2)
    if not key:
        print("⚠️  未从 credentials 取到 key，仍尝试无鉴权请求", file=sys.stderr)

    try:
        models = fetch_models(base, key)
    except Exception as e:
        print(f"❌ 拉模型失败: {e}", file=sys.stderr)
        sys.exit(1)

    if args.raw:
        for m in sorted(models):
            print(m)
        return

    groups = {"openai": [], "anthropic": [], "vertex": []}
    for m in models:
        groups[protocol_of(m)].append(m)

    print(f"📦 ORG-2 网关可用模型 ({len(models)} 个) · base={base}")
    print()
    for proto, items in groups.items():
        if not items:
            continue
        label, provider, base_url, api = PROTOCOLS[proto]
        print(f"── {label}  (provider={provider} · api={api})")
        print(f"   baseUrl: {base_url}")
        for m in sorted(items):
            print(f"     · {m}")
        print()
    print("提示：ORG-2 经 TiyGate 统一网关代理，运行时只需 base_url=网关地址；")
    print("      上面的三协议归属用于跨协议直连（如 banana2 走 Vertex AI）参考。")


if __name__ == "__main__":
    main()
