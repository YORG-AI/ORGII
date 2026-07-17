"""ORGII lifecycle bridge for Hermes Agent.

Integrated ORGII terminals use per-terminal callback credentials. Hermes
processes launched elsewhere discover ORGII's user-private runtime descriptor
while the app is running. Hook failures are best-effort and never affect Hermes.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

# Hermes requires the manifest declaration and runtime registration. The
# plugin test enforces exact parity so this protocol list cannot drift silently.
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
CALLBACK_FAILURE_COOLDOWN_SECONDS = 5.0
CALLBACK_TIMEOUT_SECONDS = 0.15
MAX_GLOBAL_CALLBACK_TARGETS = 4
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
_RUNTIME_PLATFORM = ""
_CALLBACK_COOLDOWN_UNTIL = 0.0


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


def _read_hook_config(path: Path) -> tuple[str, str]:
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


def _global_config_paths() -> list[Path]:
    configured_path = os.environ.get("ORGII_HERMES_HOOK_CONFIG", "")
    if configured_path:
        return [Path(configured_path).expanduser()]

    directory = Path.home() / ".orgii" / "hermes-hooks"
    try:
        paths = list(directory.glob("*.env"))
    except OSError:
        return []

    def modified_at(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return -1.0

    # Hooks run synchronously inside Hermes. Bound stale-endpoint fallback while
    # still covering the realistic number of concurrently running app processes.
    return sorted(paths, key=modified_at, reverse=True)[
        :MAX_GLOBAL_CALLBACK_TARGETS
    ]


def _hook_targets() -> list[tuple[str, str, str]]:
    endpoint = os.environ.get("ORGII_HERMES_HOOK_ENDPOINT", "")
    token = os.environ.get("ORGII_HERMES_HOOK_TOKEN", "")
    terminal_session_id = os.environ.get("ORGII_TERMINAL_SESSION_ID", "")
    if endpoint and token and terminal_session_id:
        return [(endpoint, token, terminal_session_id)]

    targets = []
    for path in _global_config_paths():
        endpoint, token = _read_hook_config(path)
        if endpoint and token:
            targets.append((endpoint, token, ""))
    return targets


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


def _should_forward_event(kwargs: dict[str, Any]) -> bool:
    """Limit the globally enabled plugin to interactive CLI/TUI sessions."""

    global _RUNTIME_PLATFORM

    platform = _safe_text(kwargs.get("platform"), 24).lower()
    if platform:
        _RUNTIME_PLATFORM = platform
    approval_surface = _safe_text(kwargs.get("surface"), 24).lower()
    return approval_surface != "gateway" and _RUNTIME_PLATFORM in {"", "cli"}


def _post_event(event_name: str, kwargs: dict[str, Any]) -> None:
    global _CALLBACK_COOLDOWN_UNTIL, _CURRENT_SESSION_ID, _RUNTIME_PLATFORM

    try:
        if not _should_forward_event(kwargs):
            return
        if time.monotonic() < _CALLBACK_COOLDOWN_UNTIL:
            return

        targets = _hook_targets()
        if not targets:
            return

        args = kwargs.get("args") if isinstance(kwargs.get("args"), dict) else {}
        session_id = _session_identity(kwargs)
        tool_name = kwargs.get("tool_name")
        if not tool_name and event_name in {
            "pre_approval_request",
            "post_approval_response",
        }:
            tool_name = "terminal"
        event_payload = {
            "hookEventName": event_name,
            "sessionId": _safe_text(session_id),
            "toolName": _safe_text(tool_name, 80),
            "toolInputPreview": _tool_input_preview(event_name, kwargs),
            "model": _safe_text(kwargs.get("model"), 120),
            "cwd": _safe_text(kwargs.get("cwd") or args.get("cwd") or os.getcwd()),
            "durationMs": _optional_number(kwargs.get("duration_ms")),
            "approvalSurface": _safe_text(kwargs.get("surface"), 24),
        }
        for endpoint, token, terminal_session_id in targets:
            payload = {"payload": event_payload}
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
                with urllib.request.urlopen(request, timeout=CALLBACK_TIMEOUT_SECONDS):
                    pass
                _CALLBACK_COOLDOWN_UNTIL = 0.0
                return
            except (OSError, urllib.error.URLError):
                continue
        _CALLBACK_COOLDOWN_UNTIL = (
            time.monotonic() + CALLBACK_FAILURE_COOLDOWN_SECONDS
        )
    finally:
        if event_name == "on_session_finalize":
            _CURRENT_SESSION_ID = ""
            _RUNTIME_PLATFORM = ""


def _make_hook(event_name: str) -> Callable[..., None]:
    def _hook(**kwargs: Any) -> None:
        _post_event(event_name, kwargs)

    return _hook


def register(ctx: Any) -> None:
    for event_name in EVENTS:
        ctx.register_hook(event_name, _make_hook(event_name))
