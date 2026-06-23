#!/usr/bin/env python3
"""ZenMux Management API 查询脚本"""
import os, sys, json, urllib.request
from datetime import datetime, timezone, timedelta

API_BASE = "https://zenmux.ai/api/v1/management"
KEY = os.environ.get("ZENMUX_MANAGEMENT_KEY",
    "sk-mg-v1-7eb0ee4075005d1865dfc2f3de2d4cd7ef2a214523e5caec01b2684b23744a59")

CST = timezone(timedelta(hours=8))

def get(path):
    req = urllib.request.Request(f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        resp = json.loads(r.read())
    return resp.get("data", resp)

def _fmt_reset(iso_str, with_date_threshold_h=12.0):
    """Return (label_short, label_full) for a UTC ISO timestamp.

    label_short  : status-bar friendly, e.g. "12:09(3h36m)" or "5/6 10:53(4d)"
    label_full   : human-readable absolute, e.g. "2026-05-02 12:09 CST"
    """
    if not iso_str:
        return ("-", "-")
    try:
        # Trim trailing 'Z' / fractional seconds for fromisoformat
        s = iso_str.replace("Z", "+00:00")
        t_utc = datetime.fromisoformat(s).astimezone(timezone.utc)
        t_cst = t_utc.astimezone(CST)
        delta = t_utc - datetime.now(timezone.utc)
        secs = int(delta.total_seconds())
        sign = "-" if secs < 0 else ""
        secs = abs(secs)
        days = secs // 86400
        hours = (secs % 86400) // 3600
        mins = (secs % 3600) // 60
        if days >= 1:
            in_str = f"{sign}{days}d{hours}h"
        elif hours >= 1:
            in_str = f"{sign}{hours}h{mins:02d}m"
        else:
            in_str = f"{sign}{mins}m"

        if delta.total_seconds() / 3600 >= with_date_threshold_h:
            short = f"{t_cst.strftime('%-m/%-d %H:%M')}({in_str})"
        else:
            short = f"{t_cst.strftime('%H:%M')}({in_str})"
        full = t_cst.strftime("%Y-%m-%d %H:%M CST")
        return (short, full)
    except Exception:
        return (iso_str, iso_str)

def main():
    brief = "--brief" in sys.argv
    try:
        d = get("/subscription/detail")
    except Exception as e:
        print(f"err:{e}" if brief else f"❌ {e}")
        sys.exit(1)

    plan = d.get("plan", {})
    expires = (plan.get("expires_at") or "")[:10]
    status = d.get("account_status", "?")
    tier = plan.get("tier", "?")

    h5 = d.get("quota_5_hour", {})
    d7 = d.get("quota_7_day", {})
    h5_pct = round(h5.get("usage_percentage", 0) * 100, 1)
    d7_pct = round(d7.get("usage_percentage", 0) * 100, 1)
    h5_rem = round(h5.get("remaining_flows", 0), 1)
    d7_rem = round(d7.get("remaining_flows", 0), 1)
    h5_reset_short, h5_reset_full = _fmt_reset(h5.get("resets_at"))
    d7_reset_short, d7_reset_full = _fmt_reset(d7.get("resets_at"))

    balance_str = "N/A"
    try:
        payg = get("/payg/balance")
        balance_str = f"${payg.get('total_credits', 0):.2f}"
    except:
        pass

    if brief:
        print(
            f"5h:{h5_pct}% 7d:{d7_pct}% "
            f"5h_reset:{h5_reset_short} 7d_reset:{d7_reset_short} "
            f"exp:{expires}"
        )
    else:
        warn5 = " ⚠️" if h5_pct >= 80 else ""
        warn7 = " ⚠️" if d7_pct >= 80 else ""
        print(f"💳 PAYG 余额: {balance_str}")
        print(f"📋 订阅: {tier} · 到期: {expires} · 状态: {status}")
        print(f"⏱  5h 配额: {h5_pct}% 已用 (剩 {h5_rem} Flows) · 刷新: {h5_reset_full} ({h5_reset_short}){warn5}")
        print(f"📅 7d 配额: {d7_pct}% 已用 (剩 {d7_rem} Flows) · 刷新: {d7_reset_full} ({d7_reset_short}){warn7}")

if __name__ == "__main__":
    main()
