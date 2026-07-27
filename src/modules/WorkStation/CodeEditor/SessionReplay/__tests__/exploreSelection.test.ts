import { describe, expect, it } from "vitest";

import { resolveExploreSelection } from "../exploreSelection";

describe("resolveExploreSelection", () => {
  it("lets a manual file selection override the current explore result", () => {
    expect(
      resolveExploreSelection(
        { eventId: "list-dir-1", choice: "file" },
        "list-dir-1",
        true
      )
    ).toBe("file");
  });

  it("falls back to the explore result when the replay event changes", () => {
    expect(
      resolveExploreSelection(
        { eventId: "list-dir-1", choice: "file" },
        "list-dir-2",
        true
      )
    ).toBe("search");
  });

  it("keeps an explicit search selection for the current event", () => {
    expect(
      resolveExploreSelection(
        { eventId: "read-1", choice: "search" },
        "read-1",
        false
      )
    ).toBe("search");
  });

  it("defaults non-explore events to the file panel", () => {
    expect(resolveExploreSelection(null, "read-1", false)).toBe("file");
  });
});
