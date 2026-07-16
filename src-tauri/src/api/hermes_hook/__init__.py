"""ORGII lifecycle bridge for Hermes Agent.

Integrated ORGII terminals use per-terminal callback credentials. Hermes
processes launched elsewhere discover ORGII's user-private runtime descriptor
while the app is running. Hook failures are best-effort and never affect Hermes.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
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
_CURRENT_SESSION_ID = ""


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


def _read_global_config() -> tuple[str, str]:
    configured_path = os.environ.get("ORGII_HERMES_HOOK_CONFIG", "")
    path = (
        Path(configured_path).expanduser()
        if configured_path
        else Path.home() / ".orgii" / "hermes-hook.env"
    )
    try:
        values = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key in {
                "ORGII_HERMES_HOOK_ENDPOINT",
                "ORGII_HERMES_HOOK_TOKEN",
            }:
                values[key] = value.strip()
        return (
            values.get("ORGII_HERMES_HOOK_ENDPOINT", ""),
            values.get("ORGII_HERMES_HOOK_TOKEN", ""),
        )
    except (OSError, UnicodeError):
        return "", ""


def _hook_target() -> tuple[str, str, str]:
    endpoint = os.environ.get("ORGII_HERMES_HOOK_ENDPOINT", "")
    token = os.environ.get("ORGII_HERMES_HOOK_TOKEN", "")
    terminal_session_id = os.environ.get("ORGII_TERMINAL_SESSION_ID", "")
    if endpoint and token and terminal_session_id:
        return endpoint, token, terminal_session_id

    endpoint, token = _read_global_config()
    return endpoint, token, ""


def _session_identity(kwargs: dict[str, Any]) -> str:
    global _CURRENT_SESSION_ID

    explicit_session_id = kwargs.get("session_id")
    if explicit_session_id:
        _CURRENT_SESSION_ID = str(explicit_session_id)
    return str(
        explicit_session_id
        or _CURRENT_SESSION_ID
        or kwargs.get("session_key")
        or kwargs.get("task_id")
        or ""
    )


def _post_event(event_name: str, kwargs: dict[str, Any]) -> None:
    global _CURRENT_SESSION_ID

    endpoint, token, terminal_session_id = _hook_target()
    if not endpoint or not token:
        return

    args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
    session_id = _session_identity(kwargs)
    tool_name = kwargs.get("tool_name")
    if not tool_name and event_name in {
        "pre_approval_request",
        "post_approval_response",
    }:
        tool_name = "terminal"
    payload = {
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
    if terminal_session_id:
        payload["terminalSessionId"] = terminal_session_id
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
    finally:
        if event_name == "on_session_finalize":
            _CURRENT_SESSION_ID = ""


def _make_hook(event_name: str) -> Callable[..., None]:
    def _hook(**kwargs: Any) -> None:
        _post_event(event_name, kwargs)

    return _hook


def register(ctx: Any) -> None:
    for event_name in EVENTS:
        ctx.register_hook(event_name, _make_hook(event_name))
