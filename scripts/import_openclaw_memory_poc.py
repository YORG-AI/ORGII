#!/usr/bin/env python3
"""Import a small OpenClaw Memory V3 sample into ORG-2 learnings.

P1.5 PoC: take top N conversation_log records from Memory V3, embed them via
local qwen3 embedding service, and insert them as active ORG-2 learnings.

This intentionally does NOT overwrite existing rows; content_hash +
`INSERT OR IGNORE` make it idempotent for the same source/category/content.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import struct
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import request

MEMORY_V3 = Path.home() / ".openclaw/memory/memory_v3.json"
ORGII_DB = Path("/home/hy/clawd/projects/orgii-data/sessions.db")
EMBED_URL = "http://127.0.0.1:9876/v1/embeddings"
EMBED_MODEL = "qwen3-embedding-4b"
DEFAULT_SCOPE = "agent:builtin:os"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def content_hash(content: str, category: str = "pattern") -> str:
    normalized = " ".join(content.split()).lower()
    payload = f"{category}:{normalized}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def embed(text: str) -> tuple[list[float], str]:
    body = json.dumps({"model": EMBED_MODEL, "input": text}, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        EMBED_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req) as resp:  # noqa: S310 - localhost only
        data = json.loads(resp.read().decode("utf-8"))
    vec = data["data"][0]["embedding"]
    model = data.get("model") or EMBED_MODEL
    return [float(x) for x in vec], model


def vec_to_blob(vec: list[float]) -> bytes:
    return b"".join(struct.pack("<f", x) for x in vec)


def pick_records(memory: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    rows = memory.get("conversation_log") or []
    if not isinstance(rows, list):
        raise SystemExit("memory_v3.json conversation_log is not a list")

    # Prefer curated compact/summary/reset-import memories; avoid raw huge/noisy chunks.
    candidates: list[dict[str, Any]] = []
    for row in rows:
        content = str(row.get("content") or "").strip()
        scope = str(row.get("scope") or "")
        category = str(row.get("category") or "")
        if len(content) < 80:
            continue
        if len(content) > 4000:
            content = content[:4000] + "…"
        if not (
            "summary" in scope
            or "compact" in scope
            or "reset-import" in scope
            or category in {"general", "memory_file"}
        ):
            continue
        candidates.append({**row, "content": content})

    # Most recent first, then cap.
    candidates.sort(key=lambda r: str(r.get("timestamp") or ""), reverse=True)
    return candidates[:limit]


def ensure_table(conn: sqlite3.Connection) -> None:
    # The table already exists in ORG-2. This is a defensive check, not a full migration.
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='learnings'")
    if not cur.fetchone():
        raise SystemExit("ORG-2 learnings table does not exist; start org2 once first")


def import_records(records: list[dict[str, Any]], db_path: Path, scope: str, dry_run: bool) -> dict[str, Any]:
    conn = sqlite3.connect(str(db_path))
    ensure_table(conn)
    inserted = 0
    skipped = 0
    errors: list[str] = []
    start = time.time()

    try:
        for i, row in enumerate(records, 1):
            content = str(row["content"]).strip()
            ch = content_hash(content, "pattern")
            existing = conn.execute("SELECT id FROM learnings WHERE content_hash = ?", (ch,)).fetchone()
            if existing:
                skipped += 1
                continue

            if dry_run:
                inserted += 1
                print(f"DRY {i:02d}: {str(row.get('scope') or '')} :: {content[:90].replace(chr(10), ' ')}")
                continue

            try:
                vec, model = embed(content)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"embed failed for #{i}: {exc}")
                continue

            created = str(row.get("timestamp") or now_iso())
            updated = now_iso()
            lid = f"oc-mig-{uuid.uuid4()}"
            source_scope = str(row.get("scope") or "openclaw-memory")
            takeaway = content.splitlines()[0][:240]
            conn.execute(
                """
                INSERT OR IGNORE INTO learnings (
                    id, agent_scope, content, takeaway, category, importance, confidence,
                    embedding, embedding_model, status, content_hash, reinforcement_count,
                    source, account_id, evolution_type, parent_id, last_recalled_at,
                    source_session_id, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    lid,
                    scope,
                    content,
                    takeaway,
                    "pattern",
                    0.72,
                    0.80,
                    vec_to_blob(vec),
                    model,
                    "active",
                    ch,
                    1,
                    "reflection",
                    None,
                    "original",
                    None,
                    None,
                    f"openclaw:{source_scope}",
                    created,
                    updated,
                ),
            )
            inserted += conn.total_changes  # not exact per-row; corrected below by query if needed
            conn.commit()
    finally:
        total = conn.execute("SELECT COUNT(*) FROM learnings WHERE agent_scope = ?", (scope,)).fetchone()[0]
        active = conn.execute(
            "SELECT COUNT(*) FROM learnings WHERE agent_scope = ? AND status = 'active'", (scope,)
        ).fetchone()[0]
        conn.close()

    # For report, recompute actually imported rows by source_session_id prefix.
    conn2 = sqlite3.connect(str(db_path))
    migrated = conn2.execute(
        "SELECT COUNT(*) FROM learnings WHERE source_session_id LIKE 'openclaw:%' AND agent_scope = ?",
        (scope,),
    ).fetchone()[0]
    conn2.close()
    return {
        "candidate_count": len(records),
        "dry_run": dry_run,
        "skipped_existing": skipped,
        "migrated_rows_total": migrated,
        "scope_total": total,
        "scope_active": active,
        "errors": errors,
        "elapsed_sec": round(time.time() - start, 2),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--scope", default=DEFAULT_SCOPE)
    ap.add_argument("--memory", type=Path, default=MEMORY_V3)
    ap.add_argument("--db", type=Path, default=ORGII_DB)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    memory = json.loads(args.memory.read_text(encoding="utf-8"))
    records = pick_records(memory, args.limit)
    report = import_records(records, args.db, args.scope, args.dry_run)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["errors"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
