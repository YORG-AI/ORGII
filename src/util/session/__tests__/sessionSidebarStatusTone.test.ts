import { describe, expect, it } from "vitest";

import {
  isSessionCompletedUnread,
  resolveSessionSidebarStatusTone,
  shouldShowSessionSidebarBreathingIndicator,
  shouldShowSessionSidebarTrailingDot,
} from "../sessionSidebarStatusTone";

describe("resolveSessionSidebarStatusTone", () => {
  it("prioritizes asking over failed", () => {
    expect(
      resolveSessionSidebarStatusTone({
        status: "waiting_for_user",
        visited: false,
      })
    ).toBe("asking");
  });

  it("marks failed sessions even when unvisited", () => {
    expect(
      resolveSessionSidebarStatusTone({
        status: "failed",
        visited: false,
      })
    ).toBe("failed");
  });

  it("marks unvisited completed sessions as unread", () => {
    expect(
      resolveSessionSidebarStatusTone({
        status: "completed",
        visited: false,
      })
    ).toBe("unread");
  });

  it("does not mark visited completed sessions as unread", () => {
    expect(
      resolveSessionSidebarStatusTone({
        status: "completed",
        visited: true,
      })
    ).toBe("default");
  });
});

describe("isSessionCompletedUnread", () => {
  it("ignores merge-pending completed sessions", () => {
    expect(isSessionCompletedUnread("completed", "pending", false)).toBe(false);
  });
});

describe("shouldShowSessionSidebarBreathingIndicator", () => {
  it("shows for running sessions", () => {
    expect(shouldShowSessionSidebarBreathingIndicator("running")).toBe(true);
  });

  it("hides while waiting for user", () => {
    expect(shouldShowSessionSidebarBreathingIndicator("waiting_for_user")).toBe(
      false
    );
  });
});

describe("shouldShowSessionSidebarTrailingDot", () => {
  it("always shows failed tone", () => {
    expect(
      shouldShowSessionSidebarTrailingDot({
        status: "failed",
        tone: "failed",
      })
    ).toBe(true);
  });

  it("hides trailing dot while in progress", () => {
    expect(
      shouldShowSessionSidebarTrailingDot({
        status: "running",
        tone: "default",
      })
    ).toBe(false);
  });
});
