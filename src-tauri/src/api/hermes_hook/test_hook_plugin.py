"""Focused privacy and endpoint-resolution tests for the Hermes hook plugin."""

import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import __init__ as hook
from __init__ import (
    _hook_targets,
    _safe_text,
    _session_identity,
    _tool_input_preview,
)


class HookPluginPrivacyTest(unittest.TestCase):
    def test_manifest_and_runtime_hook_lists_match(self) -> None:
        manifest = Path(__file__).with_name("plugin.yaml").read_text(encoding="utf-8")
        manifest_events = tuple(
            line.removeprefix("  - ").strip()
            for line in manifest.splitlines()
            if line.startswith("  - ")
        )

        self.assertEqual(manifest_events, hook.EVENTS)

    def test_safe_text_redacts_common_secrets(self) -> None:
        preview = _safe_text(
            "API_TOKEN=super-secret curl -H Authorization: Bearer abc123 "
            "https://user:password@example.com"
        )

        self.assertNotIn("super-secret", preview)
        self.assertNotIn("abc123", preview)
        self.assertNotIn("password", preview)
        self.assertEqual(
            preview,
            "API_TOKEN=[redacted] curl -H Authorization: Bearer [redacted] "
            "https://[redacted]@example.com",
        )

    def test_tool_preview_only_uses_allowlisted_fields(self) -> None:
        preview = _tool_input_preview(
            "pre_tool_call",
            {
                "args": {
                    "command": "pnpm test",
                    "path": "src/app.ts",
                    "content": "private source contents",
                }
            },
        )

        self.assertEqual(preview, "path=src/app.ts · command=pnpm test")
        self.assertNotIn("private source contents", preview)

    def test_approval_preview_prefers_description(self) -> None:
        preview = _tool_input_preview(
            "pre_approval_request",
            {
                "description": "Command needs elevated access",
                "command": "rm -rf /private",
            },
        )

        self.assertEqual(preview, "Command needs elevated access")
        self.assertNotIn("rm -rf", preview)


class HookPluginEndpointTest(unittest.TestCase):
    def setUp(self) -> None:
        hook._CURRENT_SESSION_ID = ""
        hook._RUNTIME_PLATFORM = ""
        hook._CALLBACK_COOLDOWN_UNTIL = 0.0

    def test_integrated_environment_takes_priority(self) -> None:
        env = {
            "ORGII_HERMES_HOOK_ENDPOINT": "http://integrated",
            "ORGII_HERMES_HOOK_TOKEN": "terminal-token",
            "ORGII_TERMINAL_SESSION_ID": "chatpanel-hermes",
            "ORGII_HERMES_HOOK_CONFIG": "/missing/config",
        }
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(
                _hook_targets(),
                [("http://integrated", "terminal-token", "chatpanel-hermes")],
            )

    def test_external_session_reads_global_runtime_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "hermes-hook.env"
            config.write_text(
                "ORGII_HERMES_HOOK_ENDPOINT=http://127.0.0.1:13847/agent/hooks/hermes\n"
                "ORGII_HERMES_HOOK_TOKEN=global-token\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"ORGII_HERMES_HOOK_CONFIG": str(config)},
                clear=True,
            ):
                self.assertEqual(
                    _hook_targets(),
                    [
                        (
                            "http://127.0.0.1:13847/agent/hooks/hermes",
                            "global-token",
                            "",
                        ),
                    ],
                )

    def test_external_sessions_discover_newest_process_descriptors_first(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            descriptor_directory = home / ".orgii" / "hermes-hooks"
            descriptor_directory.mkdir(parents=True)
            older = descriptor_directory / "100-older.env"
            newer = descriptor_directory / "200-newer.env"
            older.write_text(
                "ORGII_HERMES_HOOK_ENDPOINT=http://older\n"
                "ORGII_HERMES_HOOK_TOKEN=older-token\n",
                encoding="utf-8",
            )
            newer.write_text(
                "ORGII_HERMES_HOOK_ENDPOINT=http://newer\n"
                "ORGII_HERMES_HOOK_TOKEN=newer-token\n",
                encoding="utf-8",
            )
            os.utime(older, (1, 1))
            os.utime(newer, (2, 2))

            with patch.object(hook.Path, "home", return_value=home), patch.dict(
                os.environ, {}, clear=True
            ):
                self.assertEqual(
                    _hook_targets(),
                    [
                        ("http://newer", "newer-token", ""),
                        ("http://older", "older-token", ""),
                    ],
                )

    def test_external_callback_falls_back_to_an_older_live_process(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        attempted_endpoints = []

        def open_target(request, timeout):
            self.assertEqual(timeout, hook.CALLBACK_TIMEOUT_SECONDS)
            attempted_endpoints.append(request.full_url)
            if request.full_url == "http://stale":
                raise urllib.error.URLError("offline")
            return Response()

        with patch.object(
            hook,
            "_hook_targets",
            return_value=[
                ("http://stale", "stale-token", ""),
                ("http://live", "live-token", ""),
            ],
        ), patch.object(hook.urllib.request, "urlopen", side_effect=open_target):
            hook._post_event("on_session_start", {"session_id": "session-a"})

        self.assertEqual(attempted_endpoints, ["http://stale", "http://live"])
        self.assertEqual(hook._CALLBACK_COOLDOWN_UNTIL, 0.0)

    def test_external_payload_omits_terminal_identity(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        captured = []

        def capture(request, timeout):
            captured.append((request, timeout))
            return Response()

        with patch.object(
            hook, "_hook_targets", return_value=[("http://orgii", "token", "")]
        ), patch.object(hook.urllib.request, "urlopen", side_effect=capture):
            hook._post_event("on_session_start", {"session_id": "hermes-session"})

        body = json.loads(captured[0][0].data)
        self.assertNotIn("terminalSessionId", body)
        self.assertEqual(body["payload"]["sessionId"], "hermes-session")

    def test_tool_events_reuse_the_active_session_identity(self) -> None:
        self.assertEqual(_session_identity({"session_id": "session-a"}), "session-a")
        self.assertEqual(
            _session_identity({"task_id": "tool-task"}),
            "session-a",
        )

    def test_gateway_process_events_are_not_forwarded(self) -> None:
        with patch.object(
            hook, "_hook_targets", return_value=[("http://orgii", "token", "")]
        ), patch.object(hook.urllib.request, "urlopen") as urlopen:
            hook._post_event(
                "on_session_start",
                {"session_id": "gateway-session", "platform": "telegram"},
            )
            hook._post_event(
                "pre_tool_call",
                {"session_id": "gateway-session", "tool_name": "terminal"},
            )

        urlopen.assert_not_called()

    def test_gateway_approval_surface_is_not_forwarded(self) -> None:
        with patch.object(
            hook, "_hook_targets", return_value=[("http://orgii", "token", "")]
        ), patch.object(hook.urllib.request, "urlopen") as urlopen:
            hook._post_event(
                "pre_approval_request",
                {"session_key": "gateway-session", "surface": "gateway"},
            )

        urlopen.assert_not_called()

    def test_failed_callback_temporarily_suppresses_retries(self) -> None:
        with patch.object(
            hook, "_hook_targets", return_value=[("http://orgii", "token", "")]
        ), patch.object(
            hook.urllib.request,
            "urlopen",
            side_effect=urllib.error.URLError("offline"),
        ) as urlopen:
            hook._post_event("on_session_start", {"session_id": "session-a"})
            hook._post_event("pre_llm_call", {"session_id": "session-a"})

        self.assertEqual(urlopen.call_count, 1)

    def test_finalize_clears_runtime_state_without_a_callback_target(self) -> None:
        hook._CURRENT_SESSION_ID = "session-a"
        hook._RUNTIME_PLATFORM = "cli"
        with patch.object(hook, "_hook_targets", return_value=[]):
            hook._post_event("on_session_finalize", {})

        self.assertEqual(hook._CURRENT_SESSION_ID, "")
        self.assertEqual(hook._RUNTIME_PLATFORM, "")


if __name__ == "__main__":
    unittest.main()
