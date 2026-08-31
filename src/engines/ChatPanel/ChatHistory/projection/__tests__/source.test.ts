import { describe, expect, it } from "vitest";

import { resolveChatHistoryProjectionSource } from "../source";

describe("resolveChatHistoryProjectionSource", () => {
  it("accepts a matching session-scoped source and preserves its version", () => {
    expect(
      resolveChatHistoryProjectionSource({
        activeSessionId: "session-in-workstation",
        sourceIsOverride: false,
        sourceSessionId: "session-in-workstation",
        sourceVersion: 42,
      })
    ).toEqual({ enabled: true, sourceVersion: 42 });
  });

  it("rejects events from a stale session during a pipeline switch", () => {
    expect(
      resolveChatHistoryProjectionSource({
        activeSessionId: "next-session",
        sourceIsOverride: false,
        sourceSessionId: "previous-session",
        sourceVersion: 7,
      }).enabled
    ).toBe(false);
  });

  it("allows an explicit merged-history override", () => {
    expect(
      resolveChatHistoryProjectionSource({
        activeSessionId: "coordinator",
        sourceIsOverride: true,
        sourceSessionId: "member-session",
        sourceVersion: 9,
      }).enabled
    ).toBe(true);
  });

  it("stays disabled without an active session", () => {
    expect(
      resolveChatHistoryProjectionSource({
        activeSessionId: null,
        sourceIsOverride: true,
        sourceSessionId: null,
        sourceVersion: 0,
      }).enabled
    ).toBe(false);
  });
});
