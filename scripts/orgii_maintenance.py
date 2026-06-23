#!/usr/bin/env python3
"""
ORG-2 定时维护脚本 (Phase 6.5 scheduler 示例)

承载 OpenClaw cron/heartbeat 不迁后遗留的运维落点：
  - health: 跑 env-check，结果落盘 logs/orgii-health-YYYY-MM-DD.log
  - quota : 记录 ZenMux 配额快照 logs/orgii-quota.jsonl（趋势用）
  - cleanup: 清理 7 天前的 health 日志

由 systemd user timer 周期触发（见 orgii-maintenance.timer）。host 侧运行。

用法:
  python3 orgii_maintenance.py            # 全部任务
  python3 orgii_maintenance.py --only health
  python3 orgii_maintenance.py --only quota
  python3 orgii_maintenance.py --only cleanup
"""
import os, sys, json, subprocess, glob, argparse, time
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
FORK_ROOT = os.path.dirname(HERE)                       # projects/orgii-fork
LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(FORK_ROOT)), "logs")  # ~/clawd/logs
CST = timezone(timedelta(hours=8))


def _ts():
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")


def _today():
    return datetime.now(CST).strftime("%Y-%m-%d")


def task_health():
    """跑 env-check，结果落盘。"""
    os.makedirs(LOG_DIR, exist_ok=True)
    out = os.path.join(LOG_DIR, f"orgii-health-{_today()}.log")
    p = subprocess.run(
        [sys.executable, os.path.join(HERE, "orgii_env_check.py")],
        capture_output=True, text=True,
    )
    with open(out, "a") as f:
        f.write(f"\n===== {_ts()} (exit={p.returncode}) =====\n")
        f.write(p.stdout)
        if p.stderr:
            f.write("\n[stderr]\n" + p.stderr)
    status = "OK" if p.returncode == 0 else "FAIL"
    print(f"[health] {status} → {out}")
    return p.returncode


def task_quota():
    """记录 ZenMux 配额快照（jsonl 追加，趋势分析用）。"""
    os.makedirs(LOG_DIR, exist_ok=True)
    out = os.path.join(LOG_DIR, "orgii-quota.jsonl")
    p = subprocess.run(
        [sys.executable, os.path.join(HERE, "orgii_zenmux_management.py"), "--brief"],
        capture_output=True, text=True,
    )
    line = p.stdout.strip()
    rec = {"ts": _ts(), "raw": line}
    # 解析 brief: "5h:X% 7d:Y% ... exp:DATE"
    for tok in line.split():
        if tok.startswith("5h:") and tok.endswith("%"):
            rec["h5_pct"] = tok[3:-1]
        elif tok.startswith("7d:") and tok.endswith("%"):
            rec["d7_pct"] = tok[3:-1]
        elif tok.startswith("exp:"):
            rec["expires"] = tok[4:]
    with open(out, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"[quota] {line} → {out}")
    return 0


def task_cleanup(keep_days=7):
    """清理 keep_days 之前的 health 日志。"""
    cutoff = time.time() - keep_days * 86400
    removed = 0
    for f in glob.glob(os.path.join(LOG_DIR, "orgii-health-*.log")):
        if os.path.getmtime(f) < cutoff:
            try:
                os.remove(f)
                removed += 1
            except OSError:
                pass
    print(f"[cleanup] removed {removed} health log(s) older than {keep_days}d")
    return 0


TASKS = {"health": task_health, "quota": task_quota, "cleanup": task_cleanup}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=list(TASKS), help="只跑某个任务")
    args = ap.parse_args()

    rc = 0
    tasks = [args.only] if args.only else ["health", "quota", "cleanup"]
    print(f"=== ORG-2 maintenance {_ts()} · tasks={tasks} ===")
    for name in tasks:
        try:
            rc |= TASKS[name]()
        except Exception as e:  # noqa: BLE001
            print(f"[{name}] ERROR: {e}", file=sys.stderr)
            rc |= 1
    sys.exit(rc)


if __name__ == "__main__":
    main()
