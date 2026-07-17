import { describe, expect, it } from "vitest";

import { maybeParseCodeEditorWebSocketMessage } from "./schemas";

describe("maybeParseCodeEditorWebSocketMessage", () => {
  it("passes session status broadcasts through with their payload fields", () => {
    // Shape mirrors the Rust runner's broadcast (session_runner/lifecycle.rs):
    // top-level payload fields, no timestamp.
    const raw = JSON.stringify({
      type: "code_session.status_changed",
      session_id: "abc-123",
      status: "completed",
      background: true,
      session_name: "Fix flaky test",
    });

    const parsed = maybeParseCodeEditorWebSocketMessage(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("code_session.status_changed");
    // .passthrough() must keep the undeclared payload fields — the
    // background-session monitor reads them off the parsed object.
    expect(parsed).toMatchObject({
      session_id: "abc-123",
      status: "completed",
      background: true,
      session_name: "Fix flaky test",
    });
  });

  it("still accepts repo events with timestamps", () => {
    const raw = JSON.stringify({
      type: "repo:status_updated",
      repo_id: "r1",
      timestamp: 1752700000000,
    });
    const parsed = maybeParseCodeEditorWebSocketMessage(raw);
    expect(parsed?.type).toBe("repo:status_updated");
    expect(parsed?.timestamp).toBe(1752700000000);
  });

  it("drops unknown event types", () => {
    const raw = JSON.stringify({ type: "something.else", session_id: "x" });
    expect(maybeParseCodeEditorWebSocketMessage(raw)).toBeNull();
  });
});
