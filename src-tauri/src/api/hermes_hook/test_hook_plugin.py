"""Focused tests for the embedded Hermes lifecycle plugin."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import __init__ as hook


class HookPluginTest(unittest.TestCase):
    def setUp(self) -> None:
        hook._CURRENT_SESSION_ID = ""
        hook._RUNTIME_PLATFORM = ""

    def test_manifest_and_runtime_hook_lists_match(self) -> None:
        manifest = Path(__file__).with_name("plugin.yaml").read_text(encoding="utf-8")
        manifest_events = tuple(
            line.removeprefix("  - ").strip()
            for line in manifest.splitlines()
            if line.startswith("  - ")
        )
        self.assertEqual(manifest_events, hook.EVENTS)

    def test_safe_text_redacts_common_secrets(self) -> None:
        preview = hook._safe_text(
            "API_TOKEN=super-secret curl -H Authorization: Bearer abc123 "
            "https://user:password@example.com"
        )
        self.assertEqual(
            preview,
            "API_TOKEN=[redacted] curl -H Authorization: Bearer [redacted] "
            "https://[redacted]@example.com",
        )

    def test_tool_preview_only_uses_allowlisted_fields(self) -> None:
        preview = hook._tool_input_preview(
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

    def test_endpoint_uses_current_shared_status_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            descriptor = Path(directory) / "status-endpoint.json"
            descriptor.write_text(
                json.dumps({"port": 13847, "token": "shared-token"}),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"ORGII_AGENT_STATUS_ENDPOINT": str(descriptor)},
                clear=True,
            ):
                self.assertEqual(
                    hook._endpoint(),
                    ("http://127.0.0.1:13847/hooks/hermes-status", "shared-token"),
                )

    def test_external_payload_omits_managed_session_identity(self) -> None:
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
            hook, "_endpoint", return_value=("http://orgii", "token")
        ), patch.object(hook.urllib.request, "urlopen", side_effect=capture), patch.dict(
            os.environ, {}, clear=True
        ):
            hook._post_event("on_session_start", {"session_id": "hermes-session"})

        body = json.loads(captured[0][0].data)
        self.assertEqual(body["orgiiSessionId"], "")
        self.assertEqual(body["payload"]["sessionId"], "hermes-session")
        self.assertEqual(captured[0][0].headers["X-orgii-hook-token"], "token")
        self.assertEqual(captured[0][1], hook.CALLBACK_TIMEOUT_SECONDS)

    def test_integrated_payload_carries_managed_session_identity(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        captured = []
        with patch.object(
            hook, "_endpoint", return_value=("http://orgii", "token")
        ), patch.object(
            hook.urllib.request,
            "urlopen",
            side_effect=lambda request, timeout: captured.append(request) or Response(),
        ), patch.dict(os.environ, {"ORGII_SESSION_ID": "managed-session"}, clear=True):
            hook._post_event("pre_llm_call", {"session_id": "hermes-session"})

        body = json.loads(captured[0].data)
        self.assertEqual(body["orgiiSessionId"], "managed-session")

    def test_gateway_events_are_not_forwarded(self) -> None:
        with patch.object(
            hook, "_endpoint", return_value=("http://orgii", "token")
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

    def test_finalize_clears_runtime_state_without_an_endpoint(self) -> None:
        hook._CURRENT_SESSION_ID = "session-a"
        hook._RUNTIME_PLATFORM = "cli"
        with patch.object(hook, "_endpoint", return_value=("", "")):
            hook._post_event("on_session_finalize", {})
        self.assertEqual(hook._CURRENT_SESSION_ID, "")
        self.assertEqual(hook._RUNTIME_PLATFORM, "")


if __name__ == "__main__":
    unittest.main()
