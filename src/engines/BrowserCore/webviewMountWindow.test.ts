import { describe, expect, it } from "vitest";

import {
  MAX_WARM_INACTIVE_WEBVIEWS,
  pushRecentWebviewId,
  selectMountedBrowserSessions,
} from "./webviewMountWindow";

const session = (id: string) => ({ id });

describe("pushRecentWebviewId", () => {
  it("bounds the list to the active slot plus the warm slots", () => {
    let recent: readonly string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      recent = pushRecentWebviewId(recent, id);
    }
    expect(recent).toHaveLength(MAX_WARM_INACTIVE_WEBVIEWS + 1);
    expect(recent[0]).toBe("f");
    // Oldest ids fall out of the window entirely.
    expect(recent).not.toContain("a");
  });

  it("returns the same reference when the active id is already newest", () => {
    // Keeps the render-phase setState in BrowserCore a no-op.
    const recent = pushRecentWebviewId([], "a");
    expect(pushRecentWebviewId(recent, "a")).toBe(recent);
  });

  it("moves a revisited id back to the front without duplicating it", () => {
    let recent = pushRecentWebviewId([], "a");
    recent = pushRecentWebviewId(recent, "b");
    recent = pushRecentWebviewId(recent, "a");
    expect(recent).toEqual(["a", "b"]);
  });
});

describe("selectMountedBrowserSessions", () => {
  it("drops sessions that have fallen out of the recent window", () => {
    // The regression this guards: every session ever visited kept a live
    // native webview, because deactivation only parks it offscreen and
    // destroy() runs on unmount alone.
    const sessions = ["a", "b", "c", "d", "e", "f"].map(session);
    let recent: readonly string[] = [];
    for (const s of sessions) recent = pushRecentWebviewId(recent, s.id);

    const mounted = selectMountedBrowserSessions(sessions, "f", recent);

    expect(mounted.map((s) => s.id)).toEqual(["c", "d", "e", "f"]);
    expect(mounted).toHaveLength(MAX_WARM_INACTIVE_WEBVIEWS + 1);
  });

  it("always mounts the active session even when it is not in the window", () => {
    const sessions = [session("a"), session("b")];
    expect(
      selectMountedBrowserSessions(sessions, "b", []).map((s) => s.id)
    ).toEqual(["b"]);
  });

  it("mounts nothing for never-activated sessions", () => {
    // Restored-from-storage tabs stay free until first visit; they have no
    // native webview to hold, so leaving them unmounted costs nothing.
    const sessions = [session("a"), session("b")];
    expect(selectMountedBrowserSessions(sessions, "", [])).toEqual([]);
  });
});
