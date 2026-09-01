import { describe, expect, it } from "vitest";

import {
  TRAIL_IDLE_AFTER_MS,
  formatTrailElapsed,
  resolveTrailElapsedMs,
  resolveTrailPhase,
  resolveTrailRestLabel,
  resolveTrailStaleDelayMs,
} from "./agentStatusTrailMath";

describe("formatTrailElapsed", () => {
  it("shows seconds only under a minute", () => {
    expect(formatTrailElapsed(0)).toBe("0s");
    expect(formatTrailElapsed(26_400)).toBe("26s");
    expect(formatTrailElapsed(59_999)).toBe("59s");
  });

  it("keeps minutes and seconds under an hour", () => {
    expect(formatTrailElapsed(60_000)).toBe("1m 0s");
    expect(formatTrailElapsed(20 * 60_000 + 26_000)).toBe("20m 26s");
  });

  it("keeps every unit once hours are reached", () => {
    // The screenshot case: 1h 20m 26s.
    expect(formatTrailElapsed((80 * 60 + 26) * 1000)).toBe("1h 20m 26s");
    // Zero-valued middle units stay, so the string never re-shortens mid-run.
    expect(formatTrailElapsed(3_600_000)).toBe("1h 0m 0s");
  });

  it("floors a negative span at zero rather than rendering a minus", () => {
    expect(formatTrailElapsed(-5_000)).toBe("0s");
  });
});

describe("resolveTrailElapsedMs", () => {
  it("measures forward from the round's start", () => {
    expect(resolveTrailElapsedMs(1_000_000, 1_026_000)).toBe(26_000);
  });

  it("reports an unknown start as unknown", () => {
    expect(resolveTrailElapsedMs(null, 1_000_000)).toBeNull();
    expect(resolveTrailElapsedMs(Number.NaN, 1_000_000)).toBeNull();
  });

  it("reports a start in the future as unknown", () => {
    // Clock skew between the event's createdAt and this machine would
    // otherwise render as a negative duration.
    expect(resolveTrailElapsedMs(1_100_000, 1_000_000)).toBeNull();
  });
});

describe("resolveTrailPhase", () => {
  const base = {
    enabled: true,
    hasSession: true,
    inProgress: false,
    pendingAsking: false,
    stale: false,
  };

  it("hides the row on a surface that opted out", () => {
    expect(resolveTrailPhase({ ...base, enabled: false })).toBe("hidden");
    expect(
      resolveTrailPhase({ ...base, enabled: false, inProgress: true })
    ).toBe("hidden");
  });

  it("hides the row when there is no session", () => {
    expect(resolveTrailPhase({ ...base, hasSession: false })).toBe("hidden");
  });

  it("puts asking above running, exactly as the sidebar dot does", () => {
    // `waiting_for_user` is itself an IN_PROGRESS status, so a naive
    // "inProgress -> running" check reports a session parked on a question as
    // actively working. The sidebar guards this with `&& !pendingAsking`.
    expect(
      resolveTrailPhase({ ...base, inProgress: true, pendingAsking: true })
    ).toBe("asking");
  });

  it("runs while the session is in progress", () => {
    expect(resolveTrailPhase({ ...base, inProgress: true })).toBe("running");
  });

  it("rests otherwise", () => {
    expect(resolveTrailPhase(base)).toBe("idle");
  });

  it("demotes a quiet session to resting whatever its status says", () => {
    // Nothing writes a terminal status for an imported transcript when that
    // process exits, and a dropped `agent:complete` leaves the native atom
    // on `running`. Either way the trail must stop counting up.
    expect(resolveTrailPhase({ ...base, inProgress: true, stale: true })).toBe(
      "idle"
    );
  });

  it("keeps an open question open however long it has been quiet", () => {
    expect(
      resolveTrailPhase({
        ...base,
        inProgress: true,
        pendingAsking: true,
        stale: true,
      })
    ).toBe("asking");
  });
});

describe("resolveTrailStaleDelayMs", () => {
  const lastActivity = 1_000_000;

  it("waits out the remainder of the quiet window", () => {
    expect(resolveTrailStaleDelayMs(lastActivity, lastActivity + 60_000)).toBe(
      TRAIL_IDLE_AFTER_MS - 60_000
    );
  });

  it("returns zero for a session reopened after the window closed", () => {
    // A negative remainder would arrive as a synchronous state write from an
    // effect body; clamping routes it through the timer instead.
    expect(
      resolveTrailStaleDelayMs(
        lastActivity,
        lastActivity + TRAIL_IDLE_AFTER_MS + 60_000
      )
    ).toBe(0);
  });

  it("returns zero exactly on the boundary", () => {
    expect(
      resolveTrailStaleDelayMs(lastActivity, lastActivity + TRAIL_IDLE_AFTER_MS)
    ).toBe(0);
  });
});

describe("resolveTrailRestLabel", () => {
  it("lets a session ORGII runs report its agent idle", () => {
    expect(
      resolveTrailRestLabel({ isExternal: false, lastRefreshedAtMs: null })
    ).toBe("agentIdle");
  });

  it("reports the last scan for a mirrored transcript", () => {
    // ORGII does not run an imported agent and cannot know it is idle — the
    // process may be mid-turn in someone's terminal right now.
    expect(
      resolveTrailRestLabel({ isExternal: true, lastRefreshedAtMs: 1_000 })
    ).toBe("lastRefreshed");
  });

  it("says nothing when external and never scanned", () => {
    expect(
      resolveTrailRestLabel({ isExternal: true, lastRefreshedAtMs: null })
    ).toBe("none");
  });
});
