// @vitest-environment jsdom
import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session";

import {
  parseSessionOrder,
  reorderSessionIds,
  sidebarSessionOrderAtom,
  sidebarSessionSortAtom,
  sortSidebarSessions,
} from "../sidebarSessionOrder";

const sessions = [
  { session_id: "old", updated_at: "2026-01-01", status: "waiting_for_user" },
  { session_id: "new", updated_at: "2026-02-01", status: "idle" },
  { session_id: "running", updated_at: "2026-01-15", status: "running" },
] as Session[];

describe("sidebar session ordering", () => {
  it("separates priority, recency and manual order without mutating sessions", () => {
    const ids = (mode: "priority" | "updated" | "manual") =>
      sortSidebarSessions(sessions, mode, ["running", "old"]).map(
        (s) => s.session_id
      );
    expect(ids("priority")).toEqual(["old", "running", "new"]);
    expect(ids("updated")).toEqual(["new", "running", "old"]);
    expect(ids("manual")).toEqual(["running", "old", "new"]);
    expect(sessions[0].session_id).toBe("old");
  });
  it("moves in both directions and retains unloaded identities", () => {
    expect(
      reorderSessionIds(
        ["hidden", "a", "b", "c"],
        ["a", "b", "c"],
        "a",
        "c",
        true
      )
    ).toEqual(["hidden", "b", "c", "a"]);
    expect(reorderSessionIds([], ["a", "b", "c"], "c", "a", false)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(reorderSessionIds(["a", "b"], ["a", "b"], "a", "a", false)).toEqual([
      "a",
      "b",
    ]);
  });
  it("validates and bounds persisted identities", () => {
    expect(parseSessionOrder([null, "", "a", "a", 4])).toEqual(["a"]);
    expect(
      parseSessionOrder(Array.from({ length: 6000 }, (_, i) => String(i)))
    ).toHaveLength(5000);
  });
  it("persists mode and order for a fresh store", () => {
    const store = createStore();
    store.set(sidebarSessionSortAtom, "manual");
    store.set(sidebarSessionOrderAtom, ["b", "a"]);
    expect(
      JSON.parse(localStorage.getItem("orgii:sidebarSessionOrder")!)
    ).toEqual(["b", "a"]);
    const fresh = createStore();
    const unsub = fresh.sub(sidebarSessionOrderAtom, () => undefined);
    expect(fresh.get(sidebarSessionOrderAtom)).toEqual(["b", "a"]);
    unsub();
  });
});
