/**
 * sessionChannelActivity — liveness stamp regression tests.
 *
 * Regression target: the planning watchdog force-completed sessions whose
 * turns streamed only ephemeral events (tool_call_delta never bumps the
 * EventStore version), because "activity" was defined as store mutations.
 * These tests pin the channel-activity source the watchdog now consults.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  clearSessionChannelActivity,
  msSinceSessionChannelActivity,
  noteSessionChannelActivity,
} from "../sessionChannelActivity";

afterEach(() => {
  clearSessionChannelActivity();
});

describe("sessionChannelActivity", () => {
  it("returns null for a session with no observed events", () => {
    expect(msSinceSessionChannelActivity("s-unknown")).toBeNull();
  });

  it("measures recency from the latest stamp", () => {
    noteSessionChannelActivity("s1", 1_000);
    expect(msSinceSessionChannelActivity("s1", 4_500)).toBe(3_500);
  });

  it("newer stamps overwrite older ones", () => {
    noteSessionChannelActivity("s1", 1_000);
    noteSessionChannelActivity("s1", 10_000);
    expect(msSinceSessionChannelActivity("s1", 11_000)).toBe(1_000);
  });

  it("tracks sessions independently", () => {
    noteSessionChannelActivity("s1", 1_000);
    noteSessionChannelActivity("s2", 5_000);
    expect(msSinceSessionChannelActivity("s1", 6_000)).toBe(5_000);
    expect(msSinceSessionChannelActivity("s2", 6_000)).toBe(1_000);
  });

  it("floors clock skew at zero", () => {
    noteSessionChannelActivity("s1", 10_000);
    expect(msSinceSessionChannelActivity("s1", 9_000)).toBe(0);
  });

  it("clears one session without touching others", () => {
    noteSessionChannelActivity("s1", 1_000);
    noteSessionChannelActivity("s2", 1_000);
    clearSessionChannelActivity("s1");
    expect(msSinceSessionChannelActivity("s1")).toBeNull();
    expect(msSinceSessionChannelActivity("s2", 2_000)).toBe(1_000);
  });
});
