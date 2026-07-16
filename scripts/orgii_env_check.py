#!/usr/bin/env python3
"""ORG-2 环境健康检查（env-check / C4）。

对照 OpenClaw healthcheck 思路，把 ORG-2 双跑切换前必须确认的依赖
一次性探测清楚。只读、不改任何状态。

检查项：
  1. org2 进程是否在跑（容器内 PID）
  2. Unified IDE server   http://127.0.0.1:13847/agent/health
  3. Feishu channel       /agent/status -> channels.feishu.accounts.default.enabled
  4. Feishu WS connected  日志最近一条 "WebSocket connected"
  5. embedding 服务       http://localhost:9876/v1/embeddings
  6. rerank 服务          http://localhost:9877/health
  7. TiyGate 网关         http://127.0.0.1:3099/v1/models
  8. sessions.db 可读 + learnings 行数
  9. integrations.json / credentials.json 可解析 + 最近备份
 10. ZenMux 配额（management API，可选）

退出码：全 PASS=0，有 WARN=0，有 FAIL=1。
"""
from __future__ import annotations

import json
import os
import subprocess
import sqlite3
import sys
import urllib.request
from pathlib import Path

CONTAINER = "orgii-app"
DATA_DIR = Path("/home/hy/clawd/projects/orgii-data")
SESSIONS_DB = DATA_DIR / "sessions.db"
INTEGRATIONS = DATA_DIR / "integrations.json"
CREDENTIALS = DATA_DIR / "credentials.json"

PASS, WARN, FAIL = "✅ PASS", "⚠️  WARN", "❌ FAIL"
results: list[tuple[str, str, str]] = []


def add(name: str, status: str, detail: str = "") -> None:
    results.append((name, status, detail))


def http_get(url: str, timeout: float = 6.0, data: bytes | None = None, headers: dict | None = None) -> tuple[int, str]:
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 localhost only
        return r.status, r.read().decode("utf-8", "replace")


def docker_exec(cmd: str, timeout: float = 10.0) -> tuple[int, str]:
    p = subprocess.run(
        ["docker", "exec", CONTAINER, "bash", "-lc", cmd],
        capture_output=True, text=True, timeout=timeout,
    )
    return p.returncode, (p.stdout + p.stderr)


def check_process() -> None:
    try:
        rc, out = docker_exec("pgrep -f '^./target/debug/org2$' || true")
        pid = out.strip().split("\n")[0] if out.strip() else ""
        if pid:
            add("org2 process", PASS, f"pid={pid}")
        else:
            add("org2 process", FAIL, "not running")
    except Exception as exc:  # noqa: BLE001
        add("org2 process", FAIL, str(exc))


def check_ide_server() -> None:
    try:
        code, body = http_get("http://127.0.0.1:13847/agent/health")
        ok = code == 200 and '"ok"' in body
        add("IDE server :13847", PASS if ok else FAIL, f"http {code}")
    except Exception as exc:  # noqa: BLE001
        add("IDE server :13847", FAIL, str(exc))


def check_feishu_config() -> None:
    try:
        _, body = http_get("http://127.0.0.1:13847/agent/status")
        d = json.loads(body)
        acct = d.get("integrations", {}).get("channels", {}).get("feishu", {}).get("accounts", {}).get("default", {})
        if acct.get("enabled"):
            add("Feishu config", PASS, f"appId={acct.get('appId','')[:16]}… allow={len(acct.get('allowFrom',[]))}")
        else:
            add("Feishu config", WARN, "feishu.default not enabled")
    except Exception as exc:  # noqa: BLE001
        add("Feishu config", FAIL, str(exc))


def check_feishu_ws() -> None:
    try:
        rc, out = docker_exec(
            'LOG=$(ls -t /root/.orgii/logs/orgii.log.* 2>/dev/null | head -1); '
            'grep -i "WebSocket connected" "$LOG" 2>/dev/null | tail -1'
        )
        line = out.strip()
        if "WebSocket connected" in line:
            ts = line.split()[0] if line.split() else "?"
            add("Feishu WS", PASS, f"last connect {ts}")
        else:
            add("Feishu WS", WARN, "no 'WebSocket connected' in log")
    except Exception as exc:  # noqa: BLE001
        add("Feishu WS", WARN, str(exc))


def check_embedding() -> None:
    try:
        body = json.dumps({"model": "qwen3-embedding-4b", "input": "健康检查"}).encode()
        code, resp = http_get("http://localhost:9876/v1/embeddings", data=body,
                              headers={"Content-Type": "application/json"})
        dims = len(json.loads(resp)["data"][0]["embedding"])
        add("embedding :9876", PASS if dims > 0 else FAIL, f"dims={dims}")
    except Exception as exc:  # noqa: BLE001
        add("embedding :9876", FAIL, str(exc))


def check_rerank() -> None:
    try:
        code, resp = http_get("http://localhost:9877/health")
        ok = '"ok"' in resp or "status" in resp
        add("rerank :9877", PASS if ok else FAIL, resp.strip()[:60])
    except Exception as exc:  # noqa: BLE001
        add("rerank :9877", FAIL, str(exc))


def check_tiygate() -> None:
    try:
        code, resp = http_get("http://127.0.0.1:3099/v1/models")
        n = len(json.loads(resp).get("data", [])) if resp.strip().startswith("{") else 0
        add("TiyGate :3099", PASS if code == 200 else FAIL, f"http {code}, models={n}")
    except Exception as exc:  # noqa: BLE001
        add("TiyGate :3099", FAIL, str(exc))


def check_db() -> None:
    try:
        # Read host-side copy; DB is container-root owned so read-only here.
        con = sqlite3.connect(f"file:{SESSIONS_DB}?mode=ro", uri=True)
        learnings = con.execute("SELECT COUNT(*) FROM learnings").fetchone()[0]
        active = con.execute("SELECT COUNT(*) FROM learnings WHERE status='active'").fetchone()[0]
        con.close()
        add("sessions.db", PASS, f"learnings={learnings} (active={active})")
    except Exception as exc:  # noqa: BLE001
        add("sessions.db", FAIL, str(exc))


def check_config_files() -> None:
    for label, path in (("integrations.json", INTEGRATIONS), ("credentials.json", CREDENTIALS)):
        try:
            json.loads(path.read_text(encoding="utf-8"))
            baks = sorted(path.parent.glob(f"{path.name}.bak-*"))
            bak_note = f", {len(baks)} backup(s)" if baks else ", no backup yet"
            add(label, PASS, f"parses OK{bak_note}")
        except FileNotFoundError:
            add(label, WARN, "missing")
        except Exception as exc:  # noqa: BLE001
            add(label, FAIL, f"parse error: {exc}")


def check_zenmux() -> None:
    key = "sk-mg-v1-7eb0ee4075005d1865dfc2f3de2d4cd7ef2a214523e5caec01b2684b23744a59"
    try:
        code, resp = http_get(
            "https://zenmux.ai/api/v1/management/subscription/detail",
            timeout=8.0, headers={"Authorization": f"Bearer {key}"})
        d = json.loads(resp)["data"]
        h5 = round(d["quota_5_hour"]["usage_percentage"] * 100, 1)
        d7 = round(d["quota_7_day"]["usage_percentage"] * 100, 1)
        add("ZenMux quota", PASS, f"5h={h5}% 7d={d7}%")
    except Exception as exc:  # noqa: BLE001
        add("ZenMux quota", WARN, f"unavailable: {exc}")


def check_e_tools() -> None:
    """E3/E4/E5/E8 运维工具迁移自查（存在 + 可编译）。"""
    import py_compile
    here = os.path.dirname(os.path.abspath(__file__))
    tools = {
        "E3 zenmux-mgmt":   "orgii_zenmux_management.py",
        "E4 model-sync":    "orgii_zenmux_models.py",
        "E5 cost-report":   "orgii_session_cost_report.py",
        "E8 banana2-image": "orgii_banana2_generate.py",
    }
    for label, fn in tools.items():
        path = os.path.join(here, fn)
        if not os.path.exists(path):
            add(label, FAIL, "missing")
            continue
        try:
            py_compile.compile(path, doraise=True)
            add(label, PASS, fn)
        except Exception as exc:  # noqa: BLE001
            add(label, FAIL, f"compile err: {exc}")


def main() -> None:
    check_process()
    check_ide_server()
    check_feishu_config()
    check_feishu_ws()
    check_embedding()
    check_rerank()
    check_tiygate()
    check_db()
    check_config_files()
    check_zenmux()
    check_e_tools()

    print("\n=== ORG-2 env-check ===")
    width = max(len(n) for n, _, _ in results)
    for name, status, detail in results:
        print(f"  {status}  {name.ljust(width)}  {detail}")

    n_fail = sum(1 for _, s, _ in results if s == FAIL)
    n_warn = sum(1 for _, s, _ in results if s == WARN)
    print(f"\n  总计: {len(results)} 项 · PASS={len(results)-n_fail-n_warn} · WARN={n_warn} · FAIL={n_fail}")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
