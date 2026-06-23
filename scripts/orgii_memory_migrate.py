#!/usr/bin/env python3
"""
ORG-2 记忆全量分层迁移 (Phase 8)

基于 P1.5 PoC（import_openclaw_memory_poc.py）增强为分层全量迁移：
  - 分层规则（plan Phase 8）：
      summary/compact 摘要类 → learnings（精华，迁）
      reset-import / daily 原始摘要 → 默认不进 learnings（防污染，--include-reset 才迁）
      硬规则/偏好 → 已走 Phase 7 personal rules，不在此迁
  - source 统一标 `imported_memory_v3`（可按 source 一键撤销）
  - 迁移前自动备份 sessions.db
  - 幂等：content_hash + INSERT OR IGNORE

用法:
  python3 orgii_memory_migrate.py --dry-run        # 预览（不写库、不 embed）
  python3 orgii_memory_migrate.py                  # 全量迁移 summary 类
  python3 orgii_memory_migrate.py --limit 100      # 限量
  python3 orgii_memory_migrate.py --include-reset  # 连 reset-import 一起迁
  python3 orgii_memory_migrate.py --rollback       # 撤销所有 imported_memory_v3 记录
  python3 orgii_memory_migrate.py --no-backup      # 跳过备份（不建议）
"""
from __future__ import annotations
import argparse, hashlib, json, shutil, sqlite3, struct, sys, time, uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib import request

MEMORY_V3 = Path(__import__("os").environ.get("ORGII_MIGRATE_MEMORY_V3",
    str(Path.home() / ".openclaw/memory/memory_v3.json")))
ORGII_DB = Path(__import__("os").environ.get("ORGII_MIGRATE_DB",
    "/home/hy/clawd/projects/orgii-data/sessions.db"))
EMBED_URL = "http://127.0.0.1:9876/v1/embeddings"
EMBED_MODEL = "qwen3-embedding-4b"
DEFAULT_SCOPE = "agent:builtin:os"
SOURCE_TAG = "imported_memory_v3"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def content_hash(content: str, category: str = "pattern") -> str:
    normalized = " ".join(content.split()).lower()
    return hashlib.sha256(f"{category}:{normalized}".encode()).hexdigest()[:16]


def vec_to_blob(vec):
    return struct.pack(f"<{len(vec)}f", *vec)


def embed(text):
    body = json.dumps({"model": EMBED_MODEL, "input": text}, ensure_ascii=False).encode()
    req = request.Request(EMBED_URL, data=body,
                          headers={"Content-Type": "application/json"}, method="POST")
    with request.urlopen(req) as resp:  # noqa: S310 localhost
        d = json.loads(resp.read())
    v = d["data"][0]["embedding"]
    return v, EMBED_MODEL


def layer_of(row):
    """分层分类：返回 'summary' / 'reset' / 'skip'。"""
    scope = str(row.get("scope") or "")
    cat = str(row.get("category") or "")
    if "reset-import" in scope:
        return "reset"
    if "summary" in scope or "compact" in scope or cat in {"general", "memory_file"}:
        return "summary"
    return "skip"


def pick_records(memory, include_reset):
    rows = memory.get("conversation_log") or []
    out = []
    for row in rows:
        content = str(row.get("content") or "").strip()
        if len(content) < 80:
            continue
        layer = layer_of(row)
        if layer == "skip":
            continue
        if layer == "reset" and not include_reset:
            continue
        if len(content) > 4000:
            content = content[:4000] + "…"
        out.append({**row, "content": content, "_layer": layer})
    out.sort(key=lambda r: str(r.get("timestamp") or ""), reverse=True)
    return out


def backup_db():
    if not ORGII_DB.exists():
        print(f"⚠️  DB 不存在，跳过备份: {ORGII_DB}", file=sys.stderr)
        return None
    ts = datetime.now().strftime("%Y%m%dT%H%M%S")
    bak = ORGII_DB.with_suffix(f".db.bak-{ts}")
    shutil.copy2(ORGII_DB, bak)
    print(f"💾 已备份 sessions.db → {bak.name}")
    return bak


MANIFEST_DIR = Path("/home/hy/clawd/logs/orgii-migrations")


def _connect_rw():
    conn = sqlite3.connect(str(ORGII_DB), timeout=30)
    conn.execute("PRAGMA busy_timeout=30000")  # 并发防御：org2 同时写时等待而非立即失败
    return conn


def rollback(migration_id=None):
    """按 migration_id（批次）精确撤销。不传则撤销最近一批。

    用 manifest 记录的本批 learning ids 删除，绝不误删将来同 source 的新记录。
    """
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    manifests = sorted(MANIFEST_DIR.glob("migration-*.json"))
    if not manifests:
        print("⚠️  无迁移 manifest，无法精确 rollback。")
        print("   （若要强制按 source 全删，用 --force-source-rollback）")
        return
    if migration_id:
        target = MANIFEST_DIR / f"migration-{migration_id}.json"
        if not target.exists():
            print(f"❌ 找不到 migration_id={migration_id} 的 manifest")
            return
    else:
        target = manifests[-1]  # 最近一批
    manifest = json.loads(target.read_text())
    ids = manifest.get("inserted_ids", [])
    if not ids:
        print(f"⚠️  manifest {target.name} 无 inserted_ids")
        return
    conn = _connect_rw()
    ph = ",".join("?" * len(ids))
    n = conn.execute(f"SELECT COUNT(*) FROM learnings WHERE id IN ({ph})", ids).fetchone()[0]
    conn.execute(f"DELETE FROM learnings WHERE id IN ({ph})", ids)
    conn.commit()
    conn.close()
    target.rename(target.with_suffix(".json.rolledback"))
    print(f"↩️  已撤销 migration={manifest.get('migration_id')} 共 {n}/{len(ids)} 条（按 manifest 精确删除）")


def force_source_rollback():
    """兜底：按 source 全删（危险，会删将来同 source 记录）。"""
    conn = _connect_rw()
    n = conn.execute("SELECT COUNT(*) FROM learnings WHERE source = ?", (SOURCE_TAG,)).fetchone()[0]
    conn.execute("DELETE FROM learnings WHERE source = ?", (SOURCE_TAG,))
    conn.commit()
    conn.close()
    print(f"↩️  [FORCE] 已按 source 撤销 {n} 条 {SOURCE_TAG}（含所有批次）")


def migrate(records, dry_run):
    conn = _connect_rw()
    if not conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'").fetchone():
        raise SystemExit("ORG-2 learnings table 不存在；先启动 org2 一次")

    migration_id = datetime.now().strftime("%Y%m%dT%H%M%S")
    inserted_ids = []
    inserted = skipped = errors = 0
    start = time.time()
    for i, row in enumerate(records, 1):
        content = row["content"].strip()
        ch = content_hash(content, "pattern")
        if conn.execute("SELECT id FROM learnings WHERE content_hash = ?", (ch,)).fetchone():
            skipped += 1
            continue
        if dry_run:
            inserted += 1
            if i <= 10 or i % 200 == 0:
                print(f"DRY {i:04d} [{row['_layer']}] {content[:80].replace(chr(10),' ')}")
            continue
        try:
            vec, model = embed(content)
        except Exception as e:  # noqa: BLE001
            errors += 1
            if errors <= 5:
                print(f"  embed fail #{i}: {e}", file=sys.stderr)
            continue
        created = str(row.get("timestamp") or now_iso())
        lid = f"oc-mig-{uuid.uuid4()}"
        takeaway = content.splitlines()[0][:240]
        conn.execute(
            """INSERT OR IGNORE INTO learnings (
                id, agent_scope, content, takeaway, category, importance, confidence,
                embedding, embedding_model, status, content_hash, reinforcement_count,
                source, account_id, evolution_type, parent_id, last_recalled_at,
                source_session_id, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (lid, DEFAULT_SCOPE, content, takeaway, "pattern", 0.72, 0.80,
             vec_to_blob(vec), model, "active", ch, 1,
             SOURCE_TAG, None, "original", None, None,
             f"openclaw:{row.get('scope') or 'memory'}", created, now_iso()),
        )
        inserted += 1
        inserted_ids.append(lid)
        if inserted % 50 == 0:
            conn.commit()
            print(f"  ... {inserted} inserted ({i}/{len(records)})")
    if not dry_run:
        conn.commit()
    conn.close()
    dur = time.time() - start
    # 写 manifest（rollback 用，按本批 ids 精确撤销）
    if not dry_run and inserted_ids:
        MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
        manifest = {
            "migration_id": migration_id,
            "source": SOURCE_TAG,
            "ts": now_iso(),
            "inserted": inserted,
            "inserted_ids": inserted_ids,
        }
        mf = MANIFEST_DIR / f"migration-{migration_id}.json"
        mf.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
        print(f"📄 manifest → {mf}")
    print(f"\n✅ 完成: migration_id={migration_id} inserted={inserted} skipped={skipped} errors={errors} · {dur:.1f}s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--include-reset", action="store_true")
    ap.add_argument("--rollback", action="store_true", help="按 manifest 撤销最近一批")
    ap.add_argument("--migration-id", help="指定撤销的批次 id")
    ap.add_argument("--force-source-rollback", action="store_true",
                    help="危险：按 source 全删（含所有批次）")
    ap.add_argument("--no-backup", action="store_true")
    args = ap.parse_args()

    if args.force_source_rollback:
        force_source_rollback()
        return
    if args.rollback or args.migration_id:
        rollback(args.migration_id)
        return

    memory = json.loads(MEMORY_V3.read_text(encoding="utf-8"))
    records = pick_records(memory, args.include_reset)
    if args.limit:
        records = records[: args.limit]

    layers = {}
    for r in records:
        layers[r["_layer"]] = layers.get(r["_layer"], 0) + 1
    print(f"📦 候选 {len(records)} 条 · 分层 {layers} · source={SOURCE_TAG}")

    if not args.dry_run and not args.no_backup:
        backup_db()
    migrate(records, args.dry_run)


if __name__ == "__main__":
    main()
