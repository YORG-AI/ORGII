"""Focused privacy tests for the embedded Hermes hook plugin."""

import unittest

from __init__ import _safe_text, _tool_input_preview


class HookPluginPrivacyTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
