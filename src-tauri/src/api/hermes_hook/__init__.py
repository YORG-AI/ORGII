"""ORGII lifecycle bridge for Hermes Agent.

The plugin is enabled globally, but it only sends events when Hermes was
started by an ORGII terminal and the per-terminal callback environment is
present. Hook failures are deliberately best-effort and never affect Hermes.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Callable

EVENTS = (
    "on_session_start",
    "pre_llm_call",
    "post_llm_call",
    "pre_tool_call",
    "post_tool_call",
    "pre_verify",
    "subagent_start",
    "subagent_stop",
    "pre_approval_request",
    "post_approval_response",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
)

MAX_PREVIEW_LENGTH = 160
SAFE_ARG_KEYS = (
    "file_path",
    "path",
    "command",
    "query",
    "url",
    "pattern",
    "description",
)
SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b([a-z0-9_]*(?:token|secret|password|passwd|api_key|private_key)[a-z0-9_]*)"
    r"\s*=\s*(?:'[^']*'|\"[^\"]*\"|[^\s]+)"
)
BEARER_TOKEN = re.compile(r"(?i)\b(bearer)\s+[^\s]+")
KNOWN_TOKEN = re.compile(r"\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b")
URL_CREDENTIALS = re.compile(r"(?<=://)[^/@\s:]+:[^/@\s]+@")


def _safe_text(value: Any, limit: int = MAX_PREVIEW_LENGTH) -> str:
    """Collapse, redact, and truncate a scalar for status-only transport."""

    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return ""
    text = " ".join(str(value).split())
    text = SECRET_ASSIGNMENT.sub(r"\1=[redacted]", text)
    text = BEARER_TOKEN.sub(r"\1 [redacted]", text)
    text = KNOWN_TOKEN.sub("[redacted]", text)
    text = URL_CREDENTIALS.sub("[redacted]@", text)
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1].rstrip()}…"


def _tool_input_preview(event_name: str, kwargs: dict[str, Any]) -> str:
    if event_name in {"pre_approval_request", "post_approval_response"}:
        # Prefer Hermes' human-readable reason over the full command being assessed.
        return _safe_text(kwargs.get("description"))

    args = kwargs.get("args")
    if not isinstance(args, dict):
        return ""
    parts: list[str] = []
    for key in SAFE_ARG_KEYS:
        value = _safe_text(args.get(key), 120)
        if value:
            parts.append(f"{key}={value}")
        if len(parts) == 2:
            break
    return _safe_text(" · ".join(parts))


def _optional_number(value: Any) -> int | float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def _post_event(event_name: str, kwargs: dict[str, Any]) -> None:
    endpoint = os.environ.get("ORGII_HERMES_HOOK_ENDPOINT", "")
    token = os.environ.get("ORGII_HERMES_HOOK_TOKEN", "")
    terminal_session_id = os.environ.get("ORGII_TERMINAL_SESSION_ID", "")
    if not endpoint or not token or not terminal_session_id:
        return

    args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
    session_id = (
        kwargs.get("session_id")
        or kwargs.get("session_key")
        or kwargs.get("task_id")
        or ""
    )
    tool_name = kwargs.get("tool_name")
    if not tool_name and event_name in {
        "pre_approval_request",
        "post_approval_response",
    }:
        tool_name = "terminal"
    payload = {
        "terminalSessionId": terminal_session_id,
        "payload": {
            "hookEventName": event_name,
            "sessionId": _safe_text(session_id),
            "toolName": _safe_text(tool_name, 80),
            "toolInputPreview": _tool_input_preview(event_name, kwargs),
            "model": _safe_text(kwargs.get("model"), 120),
            "cwd": _safe_text(kwargs.get("cwd") or args.get("cwd") or os.getcwd()),
            "durationMs": _optional_number(kwargs.get("duration_ms")),
            "approvalSurface": _safe_text(kwargs.get("surface"), 24),
        },
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-ORGII-Hermes-Hook-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=0.5):
            pass
    except (OSError, urllib.error.URLError):
        return


def _make_hook(event_name: str) -> Callable[..., None]:
    def _hook(**kwargs: Any) -> None:
        _post_event(event_name, kwargs)

    return _hook


def register(ctx: Any) -> None:
    for event_name in EVENTS:
        ctx.register_hook(event_name, _make_hook(event_name))
