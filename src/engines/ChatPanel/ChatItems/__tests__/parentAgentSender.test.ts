import { describe, expect, it } from "vitest";

import {
  resolveParentAgentSenderSessionId,
  wasSubmittedByViewer,
} from "../parentAgentSender";

describe("parent-agent message attribution", () => {
  it("attributes a subagent session's turns to the id's parent prefix", () => {
    expect(
      resolveParentAgentSenderSessionId({
        sessionId: "agentsession-root:subagent:translator",
      })
    ).toBe("agentsession-root");
  });

  it("prefers the persisted parent link over the id prefix", () => {
    expect(
      resolveParentAgentSenderSessionId({
        sessionId: "agentsession-root:subagent:translator",
        parentSessionId: "  agentsession-orchestrator  ",
      })
    ).toBe("agentsession-orchestrator");
  });

  it("attributes an Agent Team member session to its parent", () => {
    expect(
      resolveParentAgentSenderSessionId({
        sessionId: "member-session-1",
        parentSessionId: "agentsession-root",
        orgMemberId: "member-1",
      })
    ).toBe("agentsession-root");
  });

  it("attributes a background child session to its parent", () => {
    expect(
      resolveParentAgentSenderSessionId({
        sessionId: "background-session-1",
        parentSessionId: "agentsession-root",
        background: true,
      })
    ).toBe("agentsession-root");
  });

  it("leaves an ordinary continuation session with the viewer", () => {
    expect(
      resolveParentAgentSenderSessionId({
        sessionId: "continued-session",
        parentSessionId: "imported-source",
        background: false,
      })
    ).toBeNull();
  });

  it("leaves a plain session with the viewer", () => {
    expect(
      resolveParentAgentSenderSessionId({ sessionId: "agentsession-solo" })
    ).toBeNull();
  });

  it("returns null when a subagent-shaped id has no identifiable parent", () => {
    expect(
      resolveParentAgentSenderSessionId({ sessionId: ":subagent:orphan" })
    ).toBeNull();
  });
});

describe("viewer-submitted turn detection", () => {
  it("treats a turn carrying a turn-intent id as the viewer's own", () => {
    expect(
      wasSubmittedByViewer({
        source: "user",
        result: { turnIntentId: "tii-9f2c" },
      })
    ).toBe(true);
  });

  it("treats a turn with no intent id as not submitted by the viewer", () => {
    // The orchestrator starts a subagent turn with an empty intent id, so its
    // dispatch prompt reaches the transcript without one.
    expect(wasSubmittedByViewer({ source: "user", result: {} })).toBe(false);
  });

  it("ignores an empty intent id rather than reading it as a submission", () => {
    expect(
      wasSubmittedByViewer({ source: "user", result: { turnIntentId: "" } })
    ).toBe(false);
  });

  it("ignores a non-string intent id", () => {
    expect(
      wasSubmittedByViewer({ source: "user", result: { turnIntentId: 7 } })
    ).toBe(false);
  });

  it("returns false for a missing event", () => {
    expect(wasSubmittedByViewer(undefined)).toBe(false);
  });

  it("does not read an intent id off a non-user event", () => {
    expect(
      wasSubmittedByViewer({
        source: "assistant",
        result: { turnIntentId: "tii-9f2c" },
      })
    ).toBe(false);
  });
});
