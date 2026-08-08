import { beforeEach, describe, expect, it } from "vitest";

import {
  PINNED_REMOTE_SESSIONS_STORAGE_KEY,
  isRemoteSessionPinned,
  pinnedRemoteSessionKey,
  readPinnedRemoteSessionIds,
  togglePinnedRemoteSession,
  writePinnedRemoteSessionIds,
} from "./cloudPinnedRemoteSessions";

describe("cloudPinnedRemoteSessions", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keys on the org and row pair the sidebar already encodes", () => {
    expect(pinnedRemoteSessionKey("org-1", "row-9")).toBe("org-1|row-9");
  });

  it("round-trips through storage", () => {
    writePinnedRemoteSessionIds(new Set(["org-1|row-9"]));
    expect(readPinnedRemoteSessionIds()).toEqual(new Set(["org-1|row-9"]));
  });

  it("scopes a pin to its org — the same row id in another org is not pinned", () => {
    const pinned = new Set([pinnedRemoteSessionKey("org-1", "row-9")]);
    expect(isRemoteSessionPinned(pinned, "org-1", "row-9")).toBe(true);
    expect(isRemoteSessionPinned(pinned, "org-2", "row-9")).toBe(false);
  });

  it("toggles without mutating the set it was given", () => {
    const before = new Set<string>();
    const pinned = togglePinnedRemoteSession(before, "org-1", "row-9");
    expect(before.size).toBe(0);
    expect(pinned).toEqual(new Set(["org-1|row-9"]));

    const cleared = togglePinnedRemoteSession(pinned, "org-1", "row-9");
    expect(cleared.size).toBe(0);
    expect(pinned.size).toBe(1);
  });

  it("degrades to empty rather than throwing on malformed storage", () => {
    localStorage.setItem(PINNED_REMOTE_SESSIONS_STORAGE_KEY, "{not json");
    expect(readPinnedRemoteSessionIds()).toEqual(new Set());

    localStorage.setItem(
      PINNED_REMOTE_SESSIONS_STORAGE_KEY,
      JSON.stringify(["org-1|row-9", 42, null])
    );
    expect(readPinnedRemoteSessionIds()).toEqual(new Set(["org-1|row-9"]));
  });
});
