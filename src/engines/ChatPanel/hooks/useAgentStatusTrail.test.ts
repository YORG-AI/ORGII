// @vitest-environment jsdom
/**
 * The quiet-session timeout, exercised through the real hook.
 *
 * `resolveTrailPhase` is pure and tested directly; what needs a renderer is
 * the timer that feeds its `stale` input — armed for the remainder of the
 * window, re-armed when activity moves, and never firing a synchronous state
 * write from an effect body.
 */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type SmokeRoot,
  createSmokeRoot,
  settle,
} from "@src/test/reactSmokeHarness";

import { TRAIL_IDLE_AFTER_MS } from "./agentStatusTrailMath";
import { useAgentStatusTrail } from "./useAgentStatusTrail";

const NOW_MS = 1_800_000_000_000;
const MINUTE = 60_000;

/**
 * Drives the hook with a SCOPED session, so liveness comes straight from
 * `scopedIsLive` and the phase under test is decided by staleness alone.
 *
 * The phase is rendered rather than captured into a module variable — the
 * capture would be a side effect during render, which is exactly what this
 * codebase's `react-hooks/globals` rule forbids.
 */
function Probe({ lastActivityAtMs }: { lastActivityAtMs: number | null }) {
  const state = useAgentStatusTrail({
    sessionId: "sdeagent-quiet",
    turnStartedAtMs: NOW_MS - 2 * MINUTE,
    lastActivityAtMs,
    enabled: true,
    scopedIsLive: true,
  });
  return createElement("span", { "data-testid": "phase" }, state.phase);
}

let smoke: SmokeRoot;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  smoke = createSmokeRoot();
});

afterEach(async () => {
  await smoke.unmount();
  vi.useRealTimers();
});

async function mount(lastActivityAtMs: number | null): Promise<void> {
  await smoke.render(createElement(Probe, { lastActivityAtMs }));
  await settle(0);
}

const phase = () =>
  smoke.container.querySelector('[data-testid="phase"]')?.textContent;

describe("useAgentStatusTrail — quiet-session timeout", () => {
  it("stays running while the window is still open", async () => {
    await mount(NOW_MS - MINUTE);
    expect(phase()).toBe("running");

    // One minute of the five had already elapsed at mount; three more keeps
    // it inside the window.
    await settle(3 * MINUTE);

    expect(phase()).toBe("running");
  });

  it("falls back to resting once the window closes", async () => {
    await mount(NOW_MS - MINUTE);

    await settle(TRAIL_IDLE_AFTER_MS);

    expect(phase()).toBe("idle");
  });

  it("re-arms the window when new activity lands", async () => {
    await mount(NOW_MS - 4 * MINUTE);
    // 60s left on the original window.
    await settle(30_000);
    expect(phase()).toBe("running");

    // An event arrives; the session is demonstrably alive again.
    await smoke.render(createElement(Probe, { lastActivityAtMs: Date.now() }));
    await settle(2 * MINUTE);

    expect(phase()).toBe("running");
  });

  it("treats a session reopened long after its last event as quiet", async () => {
    // Already past the window at mount. The clamp routes this through the
    // timer rather than a synchronous set from the effect body.
    await mount(NOW_MS - 60 * MINUTE);
    await settle(0);

    expect(phase()).toBe("idle");
  });

  it("does not invent silence when nothing is timestamped", async () => {
    await mount(null);

    await settle(TRAIL_IDLE_AFTER_MS * 2);

    expect(phase()).toBe("running");
  });
});
