#!/usr/bin/env python3
"""Reference orgtrack exec loader plugin.

Protocol (v1): orgtrack sends one JSON request on stdin and reads one JSON
document on stdout. The environment is scrubbed (only PATH/HOME) and the CWD is
this manifest directory; the plugin never receives any database handle.

Requests:
  {"protocol": 1, "verb": "scan"}
    -> {"protocol": 1, "source": "<id>", "sessions": [ <Session>, ... ]}
  {"protocol": 1, "verb": "load", "sourceSessionId": "<id>"}
    -> {"protocol": 1, "chunks": [ <ActivityChunk>, ... ]}

Session fields (all optional except sourceSessionId; camelCase):
  sourceSessionId, name, createdAtMs, updatedAtMs, model,
  inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  repoPath, branch, filesChanged, linesAdded, linesRemoved, touchedFiles[],
  sourcePath, parentSessionId, listable

ActivityChunk fields (snake_case, matching orgtrack's internal shape):
  chunk_id, session_id, action_type, function, created_at, args, result
  - user turns: result.message.content  (role "user")
  - assistant / thinking: result.content
  - tool calls: action_type "tool_call", args.cmd / result.observation
"""
import json
import sys


def scan():
    # Replace this with real discovery of your tool's transcripts on disk.
    return {
        "protocol": 1,
        "source": "my_agent",
        "sessions": [
            {
                "sourceSessionId": "example-1",
                "name": "Example session",
                "createdAtMs": 1752900000000,
                "updatedAtMs": 1752900450000,
                "model": "my-model",
                "inputTokens": 1200,
                "outputTokens": 300,
                "repoPath": "/path/to/repo",
                "branch": "main",
                "filesChanged": 2,
                "touchedFiles": ["src/a.py", "src/b.py"],
                "sourcePath": "/path/to/transcript.json",
            }
        ],
    }


def load(source_session_id):
    # Replace this with a real read of the one transcript.
    return {
        "protocol": 1,
        "chunks": [
            {
                "chunk_id": "1",
                "session_id": source_session_id,
                "action_type": "raw",
                "function": "user_message",
                "created_at": "2026-07-19T10:00:00Z",
                "args": {},
                "result": {"message": {"role": "user", "content": "do the thing"}},
            },
            {
                "chunk_id": "2",
                "session_id": source_session_id,
                "action_type": "assistant",
                "function": "assistant",
                "created_at": "2026-07-19T10:00:03Z",
                "args": {},
                "result": {"content": "done"},
            },
        ],
    }


def main():
    request = json.load(sys.stdin)
    verb = request.get("verb")
    if verb == "scan":
        json.dump(scan(), sys.stdout)
    elif verb == "load":
        json.dump(load(request.get("sourceSessionId", "")), sys.stdout)
    else:
        sys.stderr.write(f"unknown verb: {verb!r}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
