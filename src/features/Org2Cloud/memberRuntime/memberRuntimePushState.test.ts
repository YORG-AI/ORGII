import { beforeEach, describe, expect, it } from "vitest";

import {
  emptyMemberRuntimePushState,
  memberRuntimePushStateKey,
  readMemberRuntimePushState,
  resetMemberRuntimePushState,
  writeMemberRuntimePushState,
} from "./memberRuntimePushState";
import { MEMBER_RUNTIME_PUSH_STATE_KEY_PREFIX } from "./types";

const IDENTITY = "https://cloud.example.com|user-1";
const ORG = "org-1";

describe("memberRuntimePushState", () => {
  beforeEach(() => {
    localStorage.removeItem(memberRuntimePushStateKey(IDENTITY, ORG));
  });

  it("namespaces keys per (identity, org) under the contract prefix", () => {
    expect(memberRuntimePushStateKey(IDENTITY, ORG)).toBe(
      `${MEMBER_RUNTIME_PUSH_STATE_KEY_PREFIX}:${IDENTITY}:${ORG}`
    );
  });

  it("answers the empty state when nothing is stored", () => {
    expect(readMemberRuntimePushState(IDENTITY, ORG)).toEqual(
      emptyMemberRuntimePushState()
    );
  });

  it("round-trips a written state", () => {
    const state = {
      lastPushAtMs: 1_753_000_000_000,
      usageFingerprint: { "2026-07-29|claude": "1|2|3|4|10|0.5|1|2" },
      profileFingerprint: "profile-fp",
      agentsFingerprint: null,
      lastAgentsDetectAtMs: 1_752_900_000_000,
    };
    writeMemberRuntimePushState(IDENTITY, ORG, state);
    expect(readMemberRuntimePushState(IDENTITY, ORG)).toEqual(state);
    // A different identity never sees it.
    expect(readMemberRuntimePushState("other|user-2", ORG)).toEqual(
      emptyMemberRuntimePushState()
    );
  });

  it("resets a written state back to never-pushed", () => {
    const state = {
      lastPushAtMs: 1_753_000_000_000,
      usageFingerprint: { "2026-07-29|claude": "1|2|3|4|10|0.5|1|2" },
      profileFingerprint: "profile-fp",
      agentsFingerprint: "agents-fp",
      lastAgentsDetectAtMs: 1_752_900_000_000,
    };
    writeMemberRuntimePushState(IDENTITY, ORG, state);
    expect(readMemberRuntimePushState(IDENTITY, ORG)).toEqual(state);

    resetMemberRuntimePushState(IDENTITY, ORG);

    // Back to the same "never pushed" state a first-ever read would answer:
    // the next plan re-sends every unchanged usage-day/profile/agents row
    // instead of skipping them against fingerprints the server no longer has.
    expect(readMemberRuntimePushState(IDENTITY, ORG)).toEqual(
      emptyMemberRuntimePushState()
    );
  });

  it("leaves other (identity, org) pairs untouched", () => {
    const otherOrg = "org-2";
    const state = {
      lastPushAtMs: 1_753_000_000_000,
      usageFingerprint: { "2026-07-29|claude": "1|2|3|4|10|0.5|1|2" },
      profileFingerprint: "profile-fp",
      agentsFingerprint: "agents-fp",
      lastAgentsDetectAtMs: 1_752_900_000_000,
    };
    writeMemberRuntimePushState(IDENTITY, ORG, state);
    writeMemberRuntimePushState(IDENTITY, otherOrg, state);

    resetMemberRuntimePushState(IDENTITY, ORG);

    expect(readMemberRuntimePushState(IDENTITY, ORG)).toEqual(
      emptyMemberRuntimePushState()
    );
    expect(readMemberRuntimePushState(IDENTITY, otherOrg)).toEqual(state);
    localStorage.removeItem(memberRuntimePushStateKey(IDENTITY, otherOrg));
  });

  it("degrades a corrupted stored value to the empty state", () => {
    localStorage.setItem(memberRuntimePushStateKey(IDENTITY, ORG), "{corrupt");
    expect(readMemberRuntimePushState(IDENTITY, ORG)).toEqual(
      emptyMemberRuntimePushState()
    );
    localStorage.setItem(
      memberRuntimePushStateKey(IDENTITY, ORG),
      JSON.stringify({ lastPushAtMs: "not-a-number" })
    );
    expect(readMemberRuntimePushState(IDENTITY, ORG)).toEqual(
      emptyMemberRuntimePushState()
    );
  });
});
