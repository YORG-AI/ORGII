import { describe, expect, it } from "vitest";

import { MAX_MUTED_NOTIFICATION_SESSION_IDS } from "@src/config/settingsSchema/registry/notifications";

import { updateMutedSessionIds } from "./useSessionNotificationMute";

describe("updateMutedSessionIds", () => {
  it("adds, deduplicates, and removes a session id", () => {
    expect(updateMutedSessionIds([], "session-a", true)).toEqual(["session-a"]);
    expect(
      updateMutedSessionIds(["session-b", "session-a"], "session-a", true)
    ).toEqual(["session-a", "session-b"]);
    expect(
      updateMutedSessionIds(["session-a", "session-b"], "session-a", false)
    ).toEqual(["session-b"]);
  });

  it("keeps the preference list bounded with the newest id first", () => {
    const existing = Array.from(
      { length: MAX_MUTED_NOTIFICATION_SESSION_IDS },
      (_, index) => `session-${index}`
    );
    const updated = updateMutedSessionIds(existing, "session-new", true);

    expect(updated).toHaveLength(MAX_MUTED_NOTIFICATION_SESSION_IDS);
    expect(updated[0]).toBe("session-new");
    expect(updated).not.toContain(
      `session-${MAX_MUTED_NOTIFICATION_SESSION_IDS - 1}`
    );
  });
});
