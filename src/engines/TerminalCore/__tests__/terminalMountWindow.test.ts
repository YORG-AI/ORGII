import { describe, expect, it } from "vitest";

import {
  MAX_WARM_INACTIVE_TERMINALS,
  pushRecentTerminalId,
  selectMountedTerminalSessions,
} from "../terminalMountWindow";

describe("pushRecentTerminalId", () => {
  it("returns the same reference when the active id is already first", () => {
    const prev = ["a", "b"];
    expect(pushRecentTerminalId(prev, "a")).toBe(prev);
  });

  it("moves a re-activated id to the front without duplicating it", () => {
    expect(pushRecentTerminalId(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("bounds the list to the active slot plus the warm window", () => {
    let list: readonly string[] = [];
    for (let i = 0; i < MAX_WARM_INACTIVE_TERMINALS + 5; i++) {
      list = pushRecentTerminalId(list, `t${i}`);
    }
    expect(list).toHaveLength(MAX_WARM_INACTIVE_TERMINALS + 1);
    expect(list[0]).toBe(`t${MAX_WARM_INACTIVE_TERMINALS + 4}`);
    expect(list).not.toContain("t0");
  });
});

describe("selectMountedTerminalSessions", () => {
  const sessions = ["a", "b", "c", "d"].map((id) => ({ id }));

  it("always mounts the active session even before it is initialized", () => {
    expect(
      selectMountedTerminalSessions(sessions, "d", new Set(), []).map(
        (s) => s.id
      )
    ).toEqual(["d"]);
  });

  it("only keeps initialized sessions inside the recent window mounted", () => {
    const initialized = new Set(["a", "b", "c", "d"]);
    const mounted = selectMountedTerminalSessions(sessions, "a", initialized, [
      "a",
      "c",
    ]).map((s) => s.id);
    // b and d are initialized (would previously stay mounted) but cold.
    expect(mounted).toEqual(["a", "c"]);
  });

  it("does not mount recent-but-uninitialized sessions", () => {
    expect(
      selectMountedTerminalSessions(sessions, "a", new Set(["a"]), [
        "a",
        "b",
      ]).map((s) => s.id)
    ).toEqual(["a"]);
  });
});
