#!/usr/bin/env python3
"""Reference orgtrack chunk-stage processor: redact secret-looking strings.

Protocol (v1): orgtrack sends one JSON request on stdin and reads one JSON
document on stdout. The environment is scrubbed and the CWD is this directory.

Chunk stage:
  {"protocol": 1, "stage": "chunk", "sessionId": "...", "chunks": [ <chunk>, ... ]}
    -> {"chunks": [ <chunk>, ... ]}   # same shape, transformed

Session stage (for a stage="session" processor):
  {"protocol": 1, "stage": "session", "sessions": [ <row>, ... ]}
    -> {"sessions": [ <row>, ... ]}   # rows may be dropped, renamed, annotated;
                                      # each returned row must keep source + sessionId

A processor never has to be lossless: whatever it returns replaces the input.
If it errors or returns nothing, orgtrack keeps the originals.
"""
import json
import re
import sys

# Crude secret patterns — replace with your own policy.
PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9]{16,}"),          # OpenAI-style keys
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),   # GitHub tokens
    re.compile(r"AKIA[0-9A-Z]{16}"),             # AWS access key ids
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
]


def redact(text):
    for pattern in PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


def redact_chunk(chunk):
    # Redact anywhere in the chunk by round-tripping through its JSON text.
    return json.loads(redact(json.dumps(chunk)))


def main():
    request = json.load(sys.stdin)
    if request.get("stage") == "chunk":
        chunks = [redact_chunk(c) for c in request.get("chunks", [])]
        json.dump({"chunks": chunks}, sys.stdout)
    elif request.get("stage") == "session":
        # This example only redacts chunks; pass session rows through unchanged.
        json.dump({"sessions": request.get("sessions", [])}, sys.stdout)
    else:
        sys.stderr.write(f"unknown stage: {request.get('stage')!r}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
