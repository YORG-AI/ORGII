"""Exercise generated native profiles with installed CLIs and a loopback API.

Usage: python3 scripts/verification/harness-connection-cli.py --writer <fixture-binary>
No provider credentials or workspace data are used. This is headless CLI testing.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--writer", required=True)
    args = parser.parse_args()
    writer = str(Path(args.writer).resolve())
    observed = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            observed.append((self.path, self.headers.get("authorization"), body))
            is_claude = self.path.split("?", 1)[0].endswith("/messages")
            if is_claude:
                events = [
                    {"type": "message_start", "message": {"id": "msg_fixture", "type": "message", "role": "assistant", "model": "fixture-model", "content": [], "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 0}}},
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ORGII_CONNECTION_OK"}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 3}},
                    {"type": "message_stop"},
                ]
            else:
                item = {"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "ORGII_CONNECTION_OK", "annotations": []}]}
                response = {"id": "resp_fixture", "object": "response", "created_at": 1, "model": "fixture-model", "status": "completed", "output": [item], "usage": {"input_tokens": 1, "output_tokens": 3, "total_tokens": 4}}
                events = [
                    {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                    {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}},
                    {"type": "response.content_part.added", "item_id": "msg_fixture", "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}},
                    {"type": "response.output_text.delta", "item_id": "msg_fixture", "output_index": 0, "content_index": 0, "delta": "ORGII_CONNECTION_OK"},
                    {"type": "response.output_text.done", "item_id": "msg_fixture", "output_index": 0, "content_index": 0, "text": "ORGII_CONNECTION_OK"},
                    {"type": "response.output_item.done", "output_index": 0, "item": item},
                    {"type": "response.completed", "response": response},
                ]
            if is_claude and not body.get("stream"):
                response = {"id": "msg_fixture", "type": "message", "role": "assistant", "model": "fixture-model", "content": [{"type": "text", "text": "ORGII_CONNECTION_OK"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 3}}
                raw = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            raw = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for agent, command in [("codex", "codex"), ("claude_code", "claude")]:
            executable = shutil.which(command)
            if not executable:
                raise RuntimeError(f"{command} is not installed; fixture cannot verify this harness")
            with tempfile.TemporaryDirectory(prefix="orgii-harness-fixture-") as directory:
                root = Path(directory)
                env = {key: value for key, value in os.environ.items() if key in ("PATH", "SystemRoot", "TMPDIR", "TEMP", "TMP")}
                env.update(HOME=directory, ORGII_HOME=str(root / "orgii"), ORGII_EXTERNAL_HISTORY_HOME=directory,
                           CODEX_HOME=str(root / ".codex"), CLAUDE_CONFIG_DIR=str(root / ".claude"),
                           CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_TELEMETRY="1")
                endpoint = f"http://127.0.0.1:{server.server_port}"
                subprocess.run([writer, agent, endpoint + ("/v1" if agent == "codex" else "")], env=env, cwd=root, check=True, timeout=15)
                (root / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True}))
                before = len(observed)
                arguments = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "Reply with ORGII_CONNECTION_OK"] if agent == "codex" else ["-p", "Reply with ORGII_CONNECTION_OK", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--disable-slash-commands"]
                result = subprocess.run([executable, *arguments], env=env, cwd=root, capture_output=True, text=True, timeout=45)
                requests = observed[before:]
                assert result.returncode == 0, f"{agent} failed: {result.stderr[-1800:]} {result.stdout[-500:]}"
                assert "ORGII_CONNECTION_OK" in result.stdout, f"{agent} did not render the fixture response"
                assert requests, f"{agent} did not use the configured endpoint"
                for path, authorization, body in requests:
                    assert authorization == "Bearer orgii-fixture-key", f"{agent} used a different credential"
                    assert body["model"] == "fixture-model", f"{agent} used a different model"
                print(f"PASS {agent}: native generated config -> {len(requests)} local request(s) -> rendered response")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
