#!/usr/bin/env python3
"""
ORG-2 session cost report (E5 迁移自 OpenClaw scripts/session_cost_report.py)

数据源改为 ORG-2 sessions.db 的 session_token_usage 表（不再读 OpenClaw jsonl）。
host 侧运行，只读 DB（mode=ro），不改任何状态。

用法:
  python3 orgii_session_cost_report.py            # 最近一个 session 的用量+成本
  python3 orgii_session_cost_report.py --last N    # 最近 N 个 session
  python3 orgii_session_cost_report.py --all       # 全部记录汇总
  python3 orgii_session_cost_report.py --db PATH   # 指定 db（默认宿主映射 orgii-data/sessions.db）

env:
  ORGII_SESSIONS_DB  覆盖默认 db 路径
"""
import sqlite3, sys, os, argparse
from collections import defaultdict

DEFAULT_DB = os.environ.get(
    "ORGII_SESSIONS_DB",
    "/home/hy/clawd/projects/orgii-data/sessions.db",
)

# 模型定价 (per 1M tokens, USD) —— 与 OpenClaw E5 对齐，含 ZenMux gpt-5.5 / 本地路由模型
PRICING = {
    "anthropic/claude-opus-4.6:anthropic":   {"input": 15.0, "output": 75.0, "cache_read": 1.5,  "cache_write": 18.75},
    "anthropic/claude-opus-4.8:anthropic":   {"input": 15.0, "output": 75.0, "cache_read": 1.5,  "cache_write": 18.75},
    "anthropic/claude-sonnet-4.6:anthropic": {"input": 3.0,  "output": 15.0, "cache_read": 0.3,  "cache_write": 3.75},
    "anthropic/claude-haiku-4.5:anthropic":  {"input": 0.8,  "output": 4.0,  "cache_read": 0.08, "cache_write": 1.0},
    "openai/gpt-5.5:openai":                 {"input": 1.25, "output": 10.0, "cache_read": 0.125,"cache_write": 0},
    "openai/gpt-5.4:openai":                 {"input": 10.0, "output": 40.0, "cache_read": 2.5,  "cache_write": 0},
    "openai/gpt-5.4-nano:openai":            {"input": 0.1,  "output": 0.4,  "cache_read": 0.025,"cache_write": 0},
    "openai/gpt-5.3-chat:openai":            {"input": 2.5,  "output": 10.0, "cache_read": 1.25, "cache_write": 0},
    "google/gemini-3.1-pro-preview":         {"input": 2.5,  "output": 15.0, "cache_read": 0.625,"cache_write": 0},
    "z-ai/glm-5.2":                          {"input": 0.6,  "output": 2.2,  "cache_read": 0.11, "cache_write": 0},
    "deepseek/deepseek-chat":                {"input": 0.28, "output": 0.42, "cache_read": 0.028,"cache_write": 0},
}


def match_pricing(model):
    for key in PRICING:
        if key in model or model in key:
            return PRICING[key]
    m = model.lower()
    if "opus" in m:                       return PRICING["anthropic/claude-opus-4.8:anthropic"]
    if "sonnet" in m:                     return PRICING["anthropic/claude-sonnet-4.6:anthropic"]
    if "haiku" in m:                      return PRICING["anthropic/claude-haiku-4.5:anthropic"]
    if "nano" in m:                       return PRICING["openai/gpt-5.4-nano:openai"]
    if "gpt-5.5" in m:                    return PRICING["openai/gpt-5.5:openai"]
    if "gpt-5.4" in m:                    return PRICING["openai/gpt-5.4:openai"]
    if "gpt-5.3" in m:                    return PRICING["openai/gpt-5.3-chat:openai"]
    if "gemini" in m:                     return PRICING["google/gemini-3.1-pro-preview"]
    if "glm" in m:                        return PRICING["z-ai/glm-5.2"]
    if "deepseek" in m:                   return PRICING["deepseek/deepseek-chat"]
    return {"input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_write": 3.75}  # 默认 sonnet


def calc_cost(u, p):
    return (u["input"]       / 1e6 * p["input"]
          + u["output"]      / 1e6 * p["output"]
          + u["cache_read"]  / 1e6 * p["cache_read"]
          + u["cache_write"] / 1e6 * p["cache_write"])


def short_model(model):
    m = model.lower()
    if "opus-4.8" in m: return "claude-opus-4.8"
    if "opus" in m:     return "claude-opus"
    if "sonnet" in m:   return "claude-sonnet-4.6"
    if "haiku" in m:    return "claude-haiku-4.5"
    if "nano" in m:     return "gpt-5.4-nano"
    if "gpt-5.5" in m:  return "gpt-5.5"
    if "gpt-5.4" in m:  return "gpt-5.4"
    if "gpt-5.3" in m:  return "gpt-5.3"
    if "gemini" in m:   return "gemini-3.1-pro"
    if "glm" in m:      return "glm-5.2"
    if "deepseek" in m: return "deepseek-chat"
    return model.split("/")[-1][:20]


def fmt_tok(n):
    return f"{n/1000:.1f}k" if n >= 500 else str(int(n))


def connect_ro(db):
    if not os.path.exists(db):
        print(f"❌ DB 不存在: {db}", file=sys.stderr)
        sys.exit(2)
    return sqlite3.connect(f"file:{db}?mode=ro", uri=True)


def pick_session_ids(cur, mode, last_n):
    """返回 (where_sql, params, scope_label)。"""
    if mode == "all":
        return ("1=1", [], "全部记录")
    # 取最近 N 个 distinct session（按各 session 最新 created_at）
    rows = cur.execute(
        "SELECT session_id, MAX(created_at) m FROM session_token_usage "
        "GROUP BY session_id ORDER BY m DESC LIMIT ?", [last_n]
    ).fetchall()
    if not rows:
        return (None, None, None)
    ids = [r[0] for r in rows]
    ph = ",".join("?" * len(ids))
    label = ids[0] if last_n == 1 else f"最近 {len(ids)} 个 session"
    return (f"session_id IN ({ph})", ids, label)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--last", type=int, default=1, help="最近 N 个 session")
    ap.add_argument("--all", action="store_true", help="汇总全部记录")
    args = ap.parse_args()

    con = connect_ro(args.db)
    cur = con.cursor()

    mode = "all" if args.all else "last"
    where, params, label = pick_session_ids(cur, mode, args.last)
    if where is None:
        print("No usage data in ORG-2 sessions.db.")
        return

    rows = cur.execute(
        f"SELECT model, input_tokens, output_tokens, cache_read_tokens, "
        f"cache_write_tokens, total_tokens, created_at FROM session_token_usage "
        f"WHERE {where}", params
    ).fetchall()

    if not rows:
        print("No usage data.")
        return

    usage = defaultdict(lambda: {"input": 0, "output": 0, "cache_read": 0,
                                 "cache_write": 0, "count": 0})
    start_ts = end_ts = None
    for model, inp, out, cr, cw, tot, ts in rows:
        if not model or model in ("delivery-mirror", ""):
            continue
        u = usage[model]
        u["input"]       += inp or 0
        u["output"]      += out or 0
        u["cache_read"]  += cr  or 0
        u["cache_write"] += cw  or 0
        u["count"]       += 1
        if ts:
            if not start_ts or ts < start_ts: start_ts = ts
            if not end_ts   or ts > end_ts:   end_ts = ts

    if not usage:
        print("No usage data (filtered).")
        return

    total_cost = 0.0
    out_rows = []
    for model, u in sorted(usage.items(), key=lambda x: -x[1]["count"]):
        c = calc_cost(u, match_pricing(model))
        total_cost += c
        out_rows.append((short_model(model), u, c))

    print("📊 ORG-2 会话用量报告")
    print(f"   范围: {label}")
    if start_ts:
        print(f"   时间: {start_ts[:16].replace('T', ' ')} UTC")
    print()
    for name, u, c in out_rows:
        cache = ""
        if u["cache_read"] or u["cache_write"]:
            cache = f" | cache读{fmt_tok(u['cache_read'])}/写{fmt_tok(u['cache_write'])}"
        print(f"  {name}")
        print(f"    {u['count']} 次调用 | in {fmt_tok(u['input'])} / out {fmt_tok(u['output'])}{cache}")
        print(f"    ≈ ${c:.4f}")
        print()
    print(f"  💰 总计: ${total_cost:.4f}")


if __name__ == "__main__":
    main()
