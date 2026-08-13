import { describe, expect, it } from "vitest";

import type { LinkedSession } from "@src/api/http/project/types/agentWorkflow";

import {
  buildDiscussionForwardMessage,
  pickForwardTargetSession,
} from "./discussionCommentForward";

function linked(overrides: Partial<LinkedSession>): LinkedSession {
  return {
    session_id: "sdeagent-x",
    session_type: "native",
    agent_role: "custom",
    started_at: "2026-08-01T00:00:00Z",
    status: "completed",
    cost_usd: 0,
    total_tokens: 0,
    ...overrides,
  };
}

describe("pickForwardTargetSession", () => {
  it("returns null with no linked sessions", () => {
    expect(pickForwardTargetSession(undefined)).toBeNull();
    expect(pickForwardTargetSession([])).toBeNull();
  });

  it("picks the latest top-level session by started_at", () => {
    const older = linked({
      session_id: "sdeagent-old",
      started_at: "2026-08-01T00:00:00Z",
    });
    const newer = linked({
      session_id: "sdeagent-new",
      started_at: "2026-08-05T00:00:00Z",
    });
    expect(pickForwardTargetSession([older, newer])?.session_id).toBe(
      "sdeagent-new"
    );
  });

  it("skips sub-agent sessions even when newest", () => {
    const parent = linked({
      session_id: "sdeagent-parent",
      started_at: "2026-08-01T00:00:00Z",
    });
    const sub = linked({
      session_id: "sdeagent-sub",
      started_at: "2026-08-06T00:00:00Z",
      parent_session_id: "sdeagent-parent",
    });
    expect(pickForwardTargetSession([parent, sub])?.session_id).toBe(
      "sdeagent-parent"
    );
  });
});

describe("buildDiscussionForwardMessage", () => {
  it("frames a reply turn with the org2-pm receipt command", () => {
    const { content, displayText } = buildDiscussionForwardMessage({
      shortId: "WI-0042",
      author: "vince",
      comment: "How far along is the export flow?",
    });
    expect(content).toContain("vince commented on WI-0042");
    expect(content).toContain("How far along is the export flow?");
    expect(content).toContain("org2-pm work note WI-0042 --kind comment");
    expect(content).toContain("Do not change status");
    expect(displayText).toBe("💬 How far along is the export flow?");
  });
});
